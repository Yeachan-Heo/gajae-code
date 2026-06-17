import { describe, expect, test } from "bun:test";
import { type TelegramBotApiOptions, TelegramBotApiTransport } from "../src/telegram";
import type { IncomingUpdate, OutgoingReply } from "../src/types";

interface RecordedCall {
	method: string;
	body: Record<string, unknown>;
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

/** Run the transport over a single scripted batch of updates and capture API calls. */
async function runOnce(
	updates: unknown[],
	onUpdate: (update: IncomingUpdate) => Promise<OutgoingReply | string>,
	options: Partial<TelegramBotApiOptions> = {},
	apiResults: Record<string, unknown> = {},
): Promise<RecordedCall[]> {
	const calls: RecordedCall[] = [];
	let served = false;
	let transport: TelegramBotApiTransport;
	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		const method = String(url).split("/").pop() ?? "";
		const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		calls.push({ method, body });
		if (method === "getUpdates") {
			if (served) {
				transport.stop();
				return jsonResponse({ ok: true, result: [] });
			}
			served = true;
			return jsonResponse({ ok: true, result: updates });
		}
		if (method in apiResults) return jsonResponse(apiResults[method]);
		return jsonResponse({ ok: true, result: true });
	}) as unknown as typeof fetch;
	transport = new TelegramBotApiTransport({ botToken: "t", fetchImpl, ...options });
	await transport.run(onUpdate);
	return calls;
}

const messageUpdate = { update_id: 1, message: { text: "/x", chat: { id: 100 }, from: { id: 100 } } };
const callbackUpdate = {
	update_id: 2,
	callback_query: { id: "cbq", data: "gtr:v1:tok", from: { id: 100 }, message: { message_id: 5, chat: { id: 100 } } },
};

async function sendWithResult(
	apiResult: unknown,
): Promise<{ result: { ok: boolean; retryAfterMs?: number }; calls: RecordedCall[] }> {
	const calls: RecordedCall[] = [];
	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		const method = String(url).split("/").pop() ?? "";
		const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		calls.push({ method, body });
		return jsonResponse(apiResult);
	}) as unknown as typeof fetch;
	const transport = new TelegramBotApiTransport({ botToken: "t", fetchImpl, registerBotCommands: false });
	const result = await transport.send({ chatId: "100", reply: { kind: "chat", text: "hello", parseMode: "HTML" } });
	return { result, calls };
}

describe("TelegramBotApiTransport", () => {
	test("long-polls with callback_query in allowed_updates and registers a hyphen-free command menu", async () => {
		const calls = await runOnce([], async () => "", { registerBotCommands: true });
		const getUpdates = calls.find(c => c.method === "getUpdates");
		expect(getUpdates?.body.allowed_updates).toEqual(["message", "callback_query"]);
		const setCommands = calls.find(c => c.method === "setMyCommands");
		const names = (setCommands?.body.commands as Array<{ command: string }>).map(c => c.command);
		expect(names).toEqual(["sessions", "observe", "presets", "stop", "help", "start"]);
		expect(names.some(n => n.includes("-"))).toBe(false);
	});

	test("registers custom botCommands when provided", async () => {
		const botCommands = [
			{ command: "attach", description: "Attach this chat to the RPC session" },
			{ command: "detach", description: "Detach (session keeps running)" },
		];
		const calls = await runOnce([], async () => "", { registerBotCommands: true, botCommands });
		const setCommands = calls.find(c => c.method === "setMyCommands");
		expect(setCommands?.body.commands).toEqual(botCommands);
	});

	test("sends a chat reply with parse_mode and reply_markup (callbackData -> callback_data)", async () => {
		const calls = await runOnce([messageUpdate], async () => ({
			kind: "chat",
			text: "hi",
			parseMode: "HTML",
			replyMarkup: { inline_keyboard: [[{ text: "Observe", callbackData: "gtr:v1:z" }]] },
		}));
		const send = calls.find(c => c.method === "sendMessage");
		expect(send?.body.text).toBe("hi");
		expect(send?.body.parse_mode).toBe("HTML");
		const markup = send?.body.reply_markup as {
			inline_keyboard: Array<Array<{ callback_data: string; text: string }>>;
		};
		expect(markup.inline_keyboard[0][0]).toEqual({ text: "Observe", callback_data: "gtr:v1:z" });
	});

	test("normalizes callback queries and always answers, sending the chat reply too", async () => {
		const received: IncomingUpdate[] = [];
		const calls = await runOnce([callbackUpdate], async update => {
			received.push(update);
			return { kind: "chat", text: "view", callbackAnswer: { text: "Done." } };
		});
		expect(received[0]).toEqual({
			kind: "callback_query",
			callbackQueryId: "cbq",
			userId: "100",
			chatId: "100",
			messageId: 5,
			data: "gtr:v1:tok",
		});
		const answer = calls.find(c => c.method === "answerCallbackQuery");
		expect(answer?.body).toEqual({ callback_query_id: "cbq", text: "Done." });
		expect(calls.some(c => c.method === "sendMessage")).toBe(true);
	});

	test("answer-only replies answer the callback but never send or edit a chat message", async () => {
		const calls = await runOnce([callbackUpdate], async () => ({
			kind: "callback_answer",
			callbackAnswer: { text: "Not authorized.", showAlert: true },
			sendMessage: false,
		}));
		const answer = calls.find(c => c.method === "answerCallbackQuery");
		expect(answer?.body).toEqual({ callback_query_id: "cbq", text: "Not authorized.", show_alert: true });
		expect(calls.some(c => c.method === "sendMessage")).toBe(false);
		expect(calls.some(c => c.method === "editMessageText")).toBe(false);
	});

	test("answers the callback even when the handler throws (finally path)", async () => {
		const calls = await runOnce([callbackUpdate], async () => {
			throw new Error("boom");
		});
		expect(calls.some(c => c.method === "answerCallbackQuery")).toBe(true);
		expect(calls.some(c => c.method === "sendMessage")).toBe(false);
	});

	test("edit path falls back to sendMessage with identical text/buttons on API failure", async () => {
		const reply: OutgoingReply = {
			kind: "chat",
			text: "refreshed",
			parseMode: "HTML",
			replyMarkup: { inline_keyboard: [[{ text: "Refresh", callbackData: "gtr:v1:r" }]] },
			edit: { messageId: 5 },
		};
		const calls = await runOnce(
			[callbackUpdate],
			async () => reply,
			{ enableEditMessageText: true },
			{ editMessageText: { ok: false } },
		);
		const edit = calls.find(c => c.method === "editMessageText");
		const send = calls.find(c => c.method === "sendMessage");
		expect(edit).toBeDefined();
		expect(send).toBeDefined();
		// Fallback carries the SAME text + buttons as the attempted edit (shared messageBody).
		expect(edit?.body.text).toBe("refreshed");
		expect(send?.body.text).toBe("refreshed");
		const sendMarkup = send?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
		expect(sendMarkup.inline_keyboard[0]?.[0]?.callback_data).toBe("gtr:v1:r");
	});

	test("drops oversized callback_data locally (never delivered as a command)", async () => {
		const oversized = "gtr:v1:".concat("a".repeat(80));
		const received: IncomingUpdate[] = [];
		await runOnce(
			[{ update_id: 3, callback_query: { id: "cbq2", data: oversized, message: { chat: { id: 100 } } } }],
			async update => {
				received.push(update);
				return { kind: "callback_answer", callbackAnswer: {}, sendMessage: false };
			},
		);
		// Oversized data is surfaced with an empty `data` so the gateway answer-onlys it as unknown.
		const got = received[0];
		expect(got?.kind === "callback_query" && got.data).toBe("");
	});

	test("send() posts sendMessage with reply body and returns ok true", async () => {
		const { result, calls } = await sendWithResult({ ok: true, result: { message_id: 1 } });
		expect(result).toEqual({ ok: true });
		expect(calls).toEqual([{ method: "sendMessage", body: { chat_id: "100", text: "hello", parse_mode: "HTML" } }]);
	});

	test("send() converts Telegram retry_after seconds to retryAfterMs", async () => {
		const { result, calls } = await sendWithResult({ ok: false, parameters: { retry_after: 3 } });
		expect(result).toEqual({ ok: false, retryAfterMs: 3000 });
		expect(calls[0]?.method).toBe("sendMessage");
	});
});
