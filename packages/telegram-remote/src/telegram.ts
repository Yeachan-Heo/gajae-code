/**
 * Telegram Bot API transport. Dependency-free long-poll adapter over the public
 * Bot API using `fetch`. It normalizes text messages and callback queries, sends
 * rich replies (HTML parse mode + inline keyboards), and ALWAYS answers callback
 * queries — never inferring the callback answer by string-matching reply text.
 */
import type { CallbackAnswer, ChatReply, IncomingUpdate, OutgoingReply, TelegramTransport } from "./types";

const DEFAULT_API_BASE = "https://api.telegram.org";
const DEFAULT_POLL_TIMEOUT_SEC = 30;
const ERROR_BACKOFF_MS = 2000;
const CALLBACK_DATA_MAX_BYTES = 64;
const GENERIC_CALLBACK_FAILURE = "Request failed.";

/** Options for the real Bot API transport. */
export interface TelegramBotApiOptions {
	botToken: string;
	apiBase?: string;
	pollTimeoutSec?: number;
	/** Honor `reply.edit` via editMessageText (with sendMessage fallback). Default false. */
	enableEditMessageText?: boolean;
	/** Register the Bot command menu at startup (non-fatal). Default true. */
	registerBotCommands?: boolean;
	/** Override the registered Bot command menu. */
	botCommands?: Array<{ command: string; description: string }>;
	/** Injectable fetch for tests. */
	fetchImpl?: typeof fetch;
}

interface TelegramUpdate {
	update_id: number;
	message?: { text?: string; chat?: { id?: number | string }; from?: { id?: number | string } };
	callback_query?: {
		id?: string;
		data?: unknown;
		from?: { id?: number | string };
		message?: { message_id?: number | string; chat?: { id?: number | string } };
	};
}

/** BotFather command menu — only [a-z0-9_] names; `/start-session` cannot be registered. */
export const BOT_COMMANDS = [
	{ command: "sessions", description: "List live/recent sessions" },
	{ command: "observe", description: "Bounded status for one session" },
	{ command: "presets", description: "List session presets" },
	{ command: "stop", description: "Request a graceful stop (confirm required)" },
	{ command: "help", description: "Show the command set" },
	{ command: "start", description: "Onboarding" },
];

export const RPC_BOT_COMMANDS = [
	{ command: "attach", description: "Attach this chat to the RPC session" },
	{ command: "detach", description: "Detach (session keeps running)" },
	{ command: "status", description: "Show attachment/session status" },
	{ command: "abort", description: "Abort the current turn" },
	{ command: "help", description: "Show the command set" },
	{ command: "start", description: "Onboarding" },
];

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function asId(value: number | string | undefined): string | null {
	return typeof value === "number" || typeof value === "string" ? String(value) : null;
}

function normalize(update: TelegramUpdate): IncomingUpdate | null {
	if (update.callback_query) {
		const cq = update.callback_query;
		const callbackQueryId = typeof cq.id === "string" ? cq.id : null;
		const data = cq.data;
		// Validate locally even though Telegram enforces the size cap.
		if (!callbackQueryId || typeof data !== "string" || Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) {
			// A callback we cannot answer (no id) is dropped; an invalid/oversized payload is
			// surfaced with blank data so the gateway answer-onlys it as unknown (never parsed).
			if (!callbackQueryId) return null;
			return {
				kind: "callback_query",
				callbackQueryId,
				userId: asId(cq.from?.id),
				chatId: asId(cq.message?.chat?.id),
				messageId: cq.message?.message_id ?? null,
				data: "",
			};
		}
		return {
			kind: "callback_query",
			callbackQueryId,
			userId: asId(cq.from?.id),
			chatId: asId(cq.message?.chat?.id),
			messageId: cq.message?.message_id ?? null,
			data,
		};
	}
	const message = update.message;
	const text = message?.text;
	const chatId = asId(message?.chat?.id);
	if (typeof text !== "string" || chatId === null) return null;
	return { kind: "message", text, chatId, userId: asId(message?.from?.id) };
}

function callbackAnswerOf(reply: OutgoingReply | string | null): CallbackAnswer | undefined {
	if (reply === null || typeof reply === "string") return undefined;
	return reply.callbackAnswer;
}

export class TelegramBotApiTransport implements TelegramTransport {
	private readonly endpoint: string;
	private readonly pollTimeoutSec: number;
	private readonly fetchImpl: typeof fetch;
	private readonly enableEdit: boolean;
	private readonly registerCommands: boolean;
	private readonly botCommands?: Array<{ command: string; description: string }>;
	private running = false;
	private initialized = false;
	private offset = 0;

	constructor(options: TelegramBotApiOptions) {
		const base = options.apiBase ?? DEFAULT_API_BASE;
		this.endpoint = `${base}/bot${options.botToken}`;
		this.pollTimeoutSec = options.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.enableEdit = options.enableEditMessageText ?? false;
		this.registerCommands = options.registerBotCommands ?? true;
		this.botCommands = options.botCommands;
	}

	async run(onUpdate: (update: IncomingUpdate) => Promise<OutgoingReply | string>): Promise<void> {
		this.running = true;
		await this.initialize();
		while (this.running) {
			const updates = await this.getUpdates();
			if (updates.length === 0) continue;
			for (const update of updates) {
				this.offset = update.update_id + 1;
				const normalized = normalize(update);
				if (!normalized) continue;
				await this.process(normalized, onUpdate);
			}
		}
	}

	stop(): void {
		this.running = false;
	}

	async send(message: { chatId: string; reply: ChatReply }): Promise<{ ok: boolean; retryAfterMs?: number }> {
		const result = await this.postResult("sendMessage", {
			chat_id: message.chatId,
			...this.messageBody(message.reply),
		});
		if (result.ok) return { ok: true };
		const retryAfter = result.body?.parameters?.retry_after;
		if (typeof retryAfter === "number" && Number.isFinite(retryAfter))
			return { ok: false, retryAfterMs: retryAfter * 1000 };
		return { ok: false };
	}

	/** Register the Bot command menu once (non-fatal). */
	private async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
		if (!this.registerCommands) return;
		await this.post("setMyCommands", { commands: this.botCommands ?? BOT_COMMANDS });
	}

	private async process(
		update: IncomingUpdate,
		onUpdate: (update: IncomingUpdate) => Promise<OutgoingReply | string>,
	): Promise<void> {
		if (update.kind === "callback_query") {
			let reply: OutgoingReply | string | null = null;
			let answer: CallbackAnswer | undefined;
			try {
				reply = await onUpdate(update);
				answer = callbackAnswerOf(reply);
			} catch {
				answer = { text: GENERIC_CALLBACK_FAILURE };
				reply = null;
			} finally {
				// Always answer the callback, even on error or answer-only reply.
				await this.answerCallbackQuery(update.callbackQueryId, answer);
			}
			// Send/edit only for chat replies; answer-only replies must not touch chat.
			if (reply !== null && typeof reply !== "string" && reply.kind === "chat" && update.chatId !== null) {
				await this.deliverChat(update.chatId, reply);
			}
			return;
		}

		let reply: OutgoingReply | string;
		try {
			reply = await onUpdate(update);
		} catch {
			reply = GENERIC_CALLBACK_FAILURE;
		}
		if (typeof reply === "string") {
			await this.sendMessage(update.chatId, { kind: "chat", text: reply });
		} else if (reply.kind === "chat") {
			await this.deliverChat(update.chatId, reply);
		}
	}

	private async deliverChat(chatId: string, reply: ChatReply): Promise<void> {
		if (reply.edit && this.enableEdit && reply.edit.messageId !== undefined) {
			const edited = await this.editMessageText(chatId, reply.edit.messageId, reply);
			if (edited) return;
		}
		await this.sendMessage(chatId, reply);
	}

	private async getUpdates(): Promise<TelegramUpdate[]> {
		try {
			const response = await this.fetchImpl(`${this.endpoint}/getUpdates`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					offset: this.offset,
					timeout: this.pollTimeoutSec,
					allowed_updates: ["message", "callback_query"],
				}),
			});
			const data = (await response.json()) as { ok?: boolean; result?: TelegramUpdate[] };
			return data.ok && Array.isArray(data.result) ? data.result : [];
		} catch {
			await sleep(ERROR_BACKOFF_MS);
			return [];
		}
	}

	private messageBody(reply: ChatReply): Record<string, unknown> {
		const body: Record<string, unknown> = { text: reply.text };
		if (reply.parseMode) body.parse_mode = reply.parseMode;
		if (reply.replyMarkup) {
			body.reply_markup = {
				inline_keyboard: reply.replyMarkup.inline_keyboard.map(row =>
					row.map(button => ({ text: button.text, callback_data: button.callbackData })),
				),
			};
		}
		return body;
	}

	private async sendMessage(chatId: string, reply: ChatReply): Promise<void> {
		await this.post("sendMessage", { chat_id: chatId, ...this.messageBody(reply) });
	}

	private async editMessageText(chatId: string, messageId: string | number, reply: ChatReply): Promise<boolean> {
		return this.post("editMessageText", { chat_id: chatId, message_id: messageId, ...this.messageBody(reply) });
	}

	private async answerCallbackQuery(callbackQueryId: string, answer: CallbackAnswer | undefined): Promise<void> {
		const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
		if (answer?.text) body.text = answer.text;
		if (answer?.showAlert) body.show_alert = true;
		await this.post("answerCallbackQuery", body);
	}

	/** POST a Bot API method; returns whether the API reported ok. Never throws. */
	private async post(method: string, body: Record<string, unknown>): Promise<boolean> {
		return (await this.postResult(method, body)).ok;
	}

	private async postResult(
		method: string,
		body: Record<string, unknown>,
	): Promise<{ ok: boolean; body: { parameters?: { retry_after?: unknown } } | null }> {
		try {
			const response = await this.fetchImpl(`${this.endpoint}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = (await response.json()) as { ok?: boolean; parameters?: { retry_after?: unknown } };
			return { ok: data.ok === true, body: data };
		} catch {
			return { ok: false, body: null };
		}
	}
}
