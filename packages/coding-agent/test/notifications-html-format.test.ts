import { describe, expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import {
	bold,
	buildButtonGrid,
	buildCompactChoiceGrid,
	buttonLabel,
	choiceButtonLabel,
	code,
	escapeHtml,
	markdownToTelegramHtml,
	numberedOptionList,
	splitTelegramHtml,
	TELEGRAM_MESSAGE_LIMIT,
	TELEGRAM_PARSE_MODE,
	truncateTelegramHtml,
} from "../src/sdk/bus/html-format";
import { TelegramNotificationDaemon } from "../src/sdk/bus/telegram-daemon";
import { buildActionMessage } from "../src/sdk/bus/telegram-reference";
import { formatIdentityHeader, renderThreadedFrame } from "../src/sdk/bus/threaded-render";

describe("escapeHtml (AC2)", () => {
	test("escapes & < > and escapes & first", () => {
		expect(escapeHtml(`<b>a & b > c</b>`)).toBe("&lt;b&gt;a &amp; b &gt; c&lt;/b&gt;");
		expect(escapeHtml("&lt;")).toBe("&amp;lt;");
	});
});

describe("markdownToTelegramHtml (AC5)", () => {
	test("bold, italic, and strikethrough", () => {
		expect(markdownToTelegramHtml("**hi**")).toBe("<b>hi</b>");
		expect(markdownToTelegramHtml("*hi*")).toBe("<i>hi</i>");
		expect(markdownToTelegramHtml("~~hi~~")).toBe("<s>hi</s>");
	});

	test("inline and fenced code escape their contents and are not re-parsed", () => {
		expect(markdownToTelegramHtml("`a<b>`")).toBe("<code>a&lt;b&gt;</code>");
		expect(markdownToTelegramHtml("```ts\nconst x = a < b && c > d;\n```")).toBe(
			"<pre>const x = a &lt; b &amp;&amp; c &gt; d;\n</pre>",
		);
		// markdown markers inside code are literal
		expect(markdownToTelegramHtml("`**not bold**`")).toBe("<code>**not bold**</code>");
	});

	test("safe links render <a>, unsafe and malformed links stay escaped literal", () => {
		expect(markdownToTelegramHtml("[site](https://example.com/a?x=1&y=2)")).toBe(
			`<a href="https://example.com/a?x=1&amp;y=2">site</a>`,
		);
		expect(markdownToTelegramHtml("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
		expect(markdownToTelegramHtml("[mail](mailto:a@b.com)")).toBe(`<a href="mailto:a@b.com">mail</a>`);
	});

	test("headers become bold and quotes become a merged blockquote", () => {
		expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
		expect(markdownToTelegramHtml("> one\n> two")).toBe("<blockquote>one\ntwo</blockquote>");
	});

	test("unbalanced markers remain literal, never unbalanced tags", () => {
		expect(markdownToTelegramHtml("**oops")).toBe("**oops");
		expect(markdownToTelegramHtml("a < b")).toBe("a &lt; b");
	});

	test("GFM tables render as an aligned monospace <pre> block", () => {
		const md = "| Name | Age |\n| --- | ---: |\n| Alice | 30 |\n| Bob | 1 |";
		expect(markdownToTelegramHtml(md)).toBe("<pre>Name  | Age\n------|----\nAlice |  30\nBob   |   1</pre>");
	});

	test("wide GFM tables render as stacked records for narrow Telegram clients", () => {
		const md =
			"| 공식 | 표현 |\n| --- | --- |\n| 이차방정식 근의 공식 | \\\\(x=\\\\frac{-b\\\\pm\\\\sqrt{b^2-4ac}}{2a}\\\\) |";
		expect(markdownToTelegramHtml(md)).toBe(
			"<b>공식</b>: 이차방정식 근의 공식\n<b>표현</b>: \\\\(x=\\\\frac{-b\\\\pm\\\\sqrt{b^2-4ac}}{2a}\\\\)",
		);
	});
	test("wide header-only GFM tables retain their grid", () => {
		const header = "This header is intentionally wider than forty-two columns";
		const html = markdownToTelegramHtml(`| ${header} |\n| --- |`);

		expect(html).toContain(`<pre>${header}\n`);
		expect(html).toContain(`${"-".repeat(header.length)}</pre>`);
	});

	test("table cell content is escaped and not re-parsed as markup", () => {
		const md = "| h |\n| --- |\n| <b>**x**</b> |";
		expect(markdownToTelegramHtml(md)).toBe("<pre>h           \n------------\n&lt;b&gt;**x**&lt;/b&gt;</pre>");
	});

	test("a row without a separator stays literal (not a table)", () => {
		expect(markdownToTelegramHtml("a | b\nc | d")).toBe("a | b\nc | d");
	});
});

describe("truncateTelegramHtml (AC7)", () => {
	test("short messages pass through unchanged", () => {
		expect(truncateTelegramHtml("hello")).toBe("hello");
	});

	test("long plain text is truncated within the limit with a marker", () => {
		const out = truncateTelegramHtml("a".repeat(5000), TELEGRAM_MESSAGE_LIMIT, "…");
		expect(out.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
		expect(out.endsWith("…")).toBe(true);
	});

	test("does not split an open tag and closes it", () => {
		const msg = `<b>${"x".repeat(40)}</b>`;
		const out = truncateTelegramHtml(msg, 20, "…");
		expect(out.length).toBeLessThanOrEqual(20);
		// Tag was opened then auto-closed; never a dangling "<b" fragment.
		expect(out).toContain("<b>");
		expect(out.endsWith("</b>…")).toBe(true);
		expect(out).not.toMatch(/<b$/);
	});

	test("never splits an entity", () => {
		const msg = `${"a".repeat(15)}&amp;tail`;
		const out = truncateTelegramHtml(msg, 18, "…");
		expect(out.length).toBeLessThanOrEqual(18);
		expect(out).not.toMatch(/&amp$/);
		expect(out).not.toMatch(/&$/);
	});
});

describe("splitTelegramHtml", () => {
	test("chunks long plain text below Telegram limit without dropping content", () => {
		const raw = "a".repeat(TELEGRAM_MESSAGE_LIMIT + 25);
		const chunks = splitTelegramHtml(raw);
		expect(chunks).toHaveLength(2);
		expect(chunks.every(chunk => chunk.length <= TELEGRAM_MESSAGE_LIMIT)).toBe(true);
		expect(chunks.join("")).toBe(raw);
	});

	test("does not split HTML tags or entities and reopens preformatted blocks", () => {
		const body = `<pre>${"x".repeat(40)}&amp;${"y".repeat(40)}</pre>`;
		const chunks = splitTelegramHtml(body, 35);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every(chunk => chunk.length <= 35)).toBe(true);
		expect(chunks.every(chunk => !chunk.includes("&amp") || chunk.includes("&amp;"))).toBe(true);
		expect(chunks.every(chunk => chunk.startsWith("<pre>") && chunk.endsWith("</pre>"))).toBe(true);
	});

	test("preserves opening tag attributes when reopening chunks", () => {
		const body = `<a href="https://example.com/${"x".repeat(20)}">${"label".repeat(20)}</a>`;
		const chunks = splitTelegramHtml(body, 70);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every(chunk => chunk.length <= 70)).toBe(true);
		expect(chunks.every(chunk => !chunk.startsWith("<a>") && !chunk.includes("<a>"))).toBe(true);
		expect(chunks.filter(chunk => chunk.startsWith("<a ")).length).toBeGreaterThan(1);
	});

	test("degrades oversized anchor tags instead of emitting over-limit chunks", () => {
		const url = `https://example.com/${"x".repeat(TELEGRAM_MESSAGE_LIMIT + 100)}`;
		const chunks = splitTelegramHtml(`<a href="${url}">label</a>`);

		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.every(chunk => chunk.length <= TELEGRAM_MESSAGE_LIMIT)).toBe(true);
		expect(chunks.join("")).toBe("label");
		expect(chunks.join("")).not.toContain("<a");
		expect(chunks.join("")).not.toContain("</a>");
	});
});

describe("button grid (AC6)", () => {
	test("buttonLabel is one-based plain text", () => {
		expect(buttonLabel("Yes", 0)).toBe("1. Yes");
		expect(buttonLabel("No", 1)).toBe("2. No");
	});

	test("buttonLabel strips an existing leading index and applies the canonical button number", () => {
		// Deep-interview options arrive pre-numbered (e.g. "1. Foo"); the Telegram
		// button must strip that and render a single, canonical one-based index
		// instead of duplicated numbering like "1. 1. Foo".
		expect(buttonLabel("1. Foo", 0)).toBe("1. Foo");
		expect(buttonLabel("2) Bar", 1)).toBe("2. Bar");
		expect(buttonLabel("  3.  Spaced", 2)).toBe("3. Spaced");
		// A stale/mismatched embedded index is replaced by the real button index.
		expect(buttonLabel("5. Foo", 0)).toBe("1. Foo");
		// A leading bare number without a dot/paren is real option text, kept as-is.
		expect(buttonLabel("3 apples", 2)).toBe("3. 3 apples");
	});

	test("numberedOptionList renders full escaped choices in message body", () => {
		expect(numberedOptionList(["1. Keep <alpha>", "Merge & continue"])).toBe(
			"1. Keep &lt;alpha&gt;\n2. Merge &amp; continue",
		);
	});

	test("compact choice grid uses numeric tap targets and preserves callback indexes", () => {
		const grid = buildCompactChoiceGrid(
			[
				"A long Deep Interview clarify choice that would be clipped by Telegram mobile",
				"Second",
				"Third",
				"Fourth",
				"Fifth",
				"Sixth",
			],
			i => `cb:${i}`,
		);
		expect(grid).toEqual([
			[
				{ text: "1", callback_data: "cb:0" },
				{ text: "2", callback_data: "cb:1" },
				{ text: "3", callback_data: "cb:2" },
				{ text: "4", callback_data: "cb:3" },
				{ text: "5", callback_data: "cb:4" },
			],
			[{ text: "6", callback_data: "cb:5" }],
		]);
	});

	test("choiceButtonLabel is compact and one-based", () => {
		expect(choiceButtonLabel(0)).toBe("1");
		expect(choiceButtonLabel(9)).toBe("10");
	});

	test("short options pack into rows of three; callback index stays zero-based", () => {
		const grid = buildButtonGrid(["Yes", "No", "Maybe", "Later"], i => `cb:${i}`);
		expect(grid).toEqual([
			[
				{ text: "1. Yes", callback_data: "cb:0" },
				{ text: "2. No", callback_data: "cb:1" },
				{ text: "3. Maybe", callback_data: "cb:2" },
			],
			[{ text: "4. Later", callback_data: "cb:3" }],
		]);
	});

	test("long or newline labels take a full-width row", () => {
		const grid = buildButtonGrid(["Yes", "This is a very long option label", "No"], i => `cb:${i}`);
		expect(grid).toEqual([
			[{ text: "1. Yes", callback_data: "cb:0" }],
			[{ text: "2. This is a very long option label", callback_data: "cb:1" }],
			[{ text: "3. No", callback_data: "cb:2" }],
		]);
	});
});

describe("buildActionMessage (AC6)", () => {
	test("ask puts full escaped options in the message body and compact numbers in the keyboard", () => {
		const rendered = buildActionMessage({
			kind: "ask",
			id: "a1",
			question: "Pick <one>",
			options: ["1. Long <choice>", "No & wait"],
		});
		expect(rendered.text).toBe(`❓ ${bold("Pick <one>")}\n\n1. Long &lt;choice&gt;\n2. No &amp; wait`);
		expect(rendered.inline_keyboard?.[0]?.[0]?.text).toBe("1");
		expect(rendered.inline_keyboard?.[0]?.[1]?.text).toBe("2");
	});

	test("idle escapes the summary and keeps the emoji", () => {
		const rendered = buildActionMessage({ kind: "idle", id: "i1", summary: "done <ok>" });
		expect(rendered.text).toBe("🟢 Agent idle\ndone &lt;ok&gt;");
	});
});

describe("threaded-render HTML treatment (AC3/AC5)", () => {
	test("identity header bolds title and wraps fields in code", () => {
		expect(formatIdentityHeader({ title: "Sess", repo: "r", branch: "b", machine: "m", sessionId: "s" })).toBe(
			`${bold("Sess")}\n• repo: ${code("r")}\n• branch: ${code("b")}\n• machine: ${code("m")}\n• session: ${code("s")}`,
		);
	});

	test("turn_stream converts markdown to Telegram HTML", () => {
		const send = renderThreadedFrame({
			type: "turn_stream",
			sessionId: "s",
			phase: "finalized",
			text: "**bold** and `code`",
		});
		expect(send?.text).toBe("<b>bold</b> and <code>code</code>");
	});
});

// --- Daemon send-site coverage (AC1) ---

function isolatedSettings(agentDir: string): Settings {
	const s = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "tok",
		"notifications.telegram.chatId": "42",
	}) as Settings;
	return new Proxy(s, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

class CapturingBotApi {
	calls: Array<{ method: string; body: any }> = [];
	async call(method: string, body: unknown): Promise<unknown> {
		this.calls.push({ method, body });
		if (method === "getChat")
			return { ok: true, result: { id: (body as { chat_id?: unknown } | null)?.chat_id, type: "private" } };
		if (method === "createForumTopic") return { ok: true, result: { message_thread_id: this.calls.length } };
		if (method === "sendMessage") return { ok: true, result: { message_id: this.calls.length } };
		return { ok: true, result: true };
	}
}

function makeDaemon(
	bot: CapturingBotApi,
	agentDir: string,
	rich: { enabled: boolean } = { enabled: false },
): TelegramNotificationDaemon {
	return new TelegramNotificationDaemon({
		settings: isolatedSettings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot as any,
		rich,
	});
}

const fakeSession = () => ({ sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() });

describe("daemon send sites force parse_mode HTML (AC1)", () => {
	test("turn_stream sendMessage sets parse_mode", async () => {
		const agentDir = Bun.env.TMPDIR ?? "/tmp";
		const bot = new CapturingBotApi();
		const daemon = makeDaemon(bot, agentDir);
		await daemon.handleSessionMessage(fakeSession() as any, {
			type: "identity_header",
			sessionId: "S",
			repo: "r",
			branch: "b",
		});
		await daemon.handleSessionMessage(fakeSession() as any, {
			type: "turn_stream",
			sessionId: "S",
			phase: "finalized",
			text: "hi",
		});
		const send = bot.calls.find(c => c.method === "sendMessage");
		expect(send?.body.parse_mode).toBe(TELEGRAM_PARSE_MODE);
	});

	test("long turn_stream sendMessage is split in order", async () => {
		const bot = new CapturingBotApi();
		const daemon = makeDaemon(bot, Bun.env.TMPDIR ?? "/tmp");
		await daemon.handleSessionMessage(fakeSession() as any, {
			type: "identity_header",
			sessionId: "S",
			repo: "r",
			branch: "b",
		});
		const raw = "a".repeat(TELEGRAM_MESSAGE_LIMIT + 25);
		await daemon.handleSessionMessage(fakeSession() as any, {
			type: "turn_stream",
			sessionId: "S",
			phase: "finalized",
			text: raw,
		});
		// The split is scheduled through the rate-limit pool: the first chunk is
		// sent on the granted slot and the continuation is re-queued, so a follow-up
		// flush drains it (one send per token — no single-slot burst).
		await daemon.handleSessionMessage(fakeSession() as any, {
			type: "turn_stream",
			sessionId: "S",
			phase: "finalized",
			text: "tail",
		});
		const texts = bot.calls
			.filter(c => c.method === "sendMessage" && c.body.text?.startsWith("a"))
			.map(c => String(c.body.text));
		expect(texts).toHaveLength(2);
		expect(texts.every(text => text.length <= TELEGRAM_MESSAGE_LIMIT)).toBe(true);
		expect(texts.join("")).toBe(raw);
	});

	test("image_attachment sendPhoto sets parse_mode", async () => {
		const bot = new CapturingBotApi();
		const daemon = makeDaemon(bot, Bun.env.TMPDIR ?? "/tmp");
		await daemon.handleSessionMessage(fakeSession() as any, {
			type: "identity_header",
			sessionId: "S",
			repo: "r",
			branch: "b",
		});
		await daemon.handleSessionMessage(fakeSession() as any, {
			type: "image_attachment",
			sessionId: "S",
			mime: "image/png",
			data: "AAAA",
			caption: "shot",
		});
		const photo = bot.calls.find(c => c.method === "sendPhoto");
		expect(photo?.body.parse_mode).toBe(TELEGRAM_PARSE_MODE);
	});

	test("action_needed sendMessage sets parse_mode and grid alias answers stay zero-based", async () => {
		const bot = new CapturingBotApi();
		const daemon = makeDaemon(bot, Bun.env.TMPDIR ?? "/tmp");
		await daemon.handleSessionMessage(fakeSession() as any, {
			type: "identity_header",
			sessionId: "S",
			repo: "r",
			branch: "b",
		});
		await daemon.handleSessionMessage(fakeSession() as any, {
			type: "action_needed",
			kind: "ask",
			id: "act-1",
			question: "Pick",
			options: ["Yes", "No"],
		});
		const send = bot.calls.find(c => c.method === "sendMessage" && c.body.reply_markup);
		expect(send?.body.parse_mode).toBe(TELEGRAM_PARSE_MODE);
		const keyboard = send?.body.reply_markup?.inline_keyboard as Array<
			Array<{ text: string; callback_data: string }>
		>;
		expect(keyboard[0]?.[0]?.text).toBe("1");
		expect(send?.body.text).toContain("1. Yes\n2. No");
		// The first button's alias must resolve to zero-based answer 0.
		const alias = keyboard[0]?.[0]?.callback_data as string;
		expect(daemon.aliasTable.get(alias)?.answer).toBe(0);
	});

	test("stale guidance sendMessage sets parse_mode", async () => {
		const bot = new CapturingBotApi();
		const daemon = makeDaemon(bot, Bun.env.TMPDIR ?? "/tmp");
		await (daemon as any).sendStaleGuidance("cb-1");
		const send = bot.calls.find(c => c.method === "sendMessage");
		expect(send?.body.parse_mode).toBe(TELEGRAM_PARSE_MODE);
	});
});

describe("default multipart sendPhoto forwards parse_mode (AC1 amendment)", () => {
	test("FormData includes parse_mode for base64 photo uploads", async () => {
		let captured: FormData | undefined;
		const fetchImpl = (async (_url: string, init: any) => {
			captured = init.body as FormData;
			return { json: async () => ({ ok: true, result: {} }) };
		}) as unknown as typeof fetch;
		const daemon = new TelegramNotificationDaemon({
			settings: isolatedSettings(Bun.env.TMPDIR ?? "/tmp"),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			fetchImpl,
		});
		await (daemon as any).botApi.call("sendPhoto", {
			chat_id: "42",
			photo: Buffer.from("img").toString("base64"),
			mime: "image/png",
			caption: "cap",
			parse_mode: TELEGRAM_PARSE_MODE,
		});
		expect(captured).toBeInstanceOf(FormData);
		expect(captured?.get("parse_mode")).toBe(TELEGRAM_PARSE_MODE);
		expect(captured?.get("caption")).toBe("cap");
	});
});
