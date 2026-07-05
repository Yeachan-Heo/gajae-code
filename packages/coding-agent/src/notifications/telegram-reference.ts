/**
 * Telegram **reference** client for the notifications SDK.
 *
 * This is an example/template, NOT an upstream-owned integration: it implements
 * the documented WS protocol (see `docs/notifications-sdk.md`) so you can copy it
 * to build Discord/Slack/etc. clients with zero upstream changes. The Bot API
 * transport shape is salvaged from the removed `telegram-remote` package.
 *
 * Flow: read the endpoint discovery file -> connect to the session WS -> render
 * `action_needed` to a Telegram chat (inline keyboard for options) -> map button
 * taps / text replies to `reply` frames -> reflect `action_resolved` /
 * `reply_rejected`.
 *
 * Dependency-free: uses global `fetch` and `WebSocket` (Bun/Node 22+).
 */

import * as fs from "node:fs";
import {
	bold,
	buildCompactChoiceGrid,
	escapeHtml,
	numberedOptionList,
	splitTelegramHtml,
	TELEGRAM_PARSE_MODE,
} from "./html-format";
import { renderThreadedFrame } from "./threaded-render";

/** One inline-keyboard button. */
export interface InlineButton {
	text: string;
	callback_data: string;
}

/** A rendered Telegram message for an `action_needed`. */
export interface RenderedMessage {
	text: string;
	inline_keyboard?: InlineButton[][];
}

type TelegramSend = (method: string, body: unknown) => Promise<Response>;

/** Encode `actionId` + option `index` into Telegram callback_data (<=64 bytes). */
export function encodeCallbackData(actionId: string, index: number): string {
	return `r:${index}:${actionId}`.slice(0, 64);
}

/** Decode callback_data produced by {@link encodeCallbackData}. */
export function decodeCallbackData(data: string): { id: string; index: number } | null {
	const m = /^r:(\d+):(.+)$/.exec(data);
	if (!m) return null;
	return { index: Number(m[1]), id: m[2]! };
}

export interface CallbackRoute {
	sessionId: string;
	actionId: string;
	answer: number | string;
}

export interface SerializedAliasTable {
	version: 1;
	next: number;
	routes: Record<string, CallbackRoute>;
}

export interface AliasTable {
	put(route: CallbackRoute): string;
	get(alias: string): CallbackRoute | undefined;
	delete(alias: string): boolean;
	serialize(): SerializedAliasTable;
	load(json: unknown): void;
	entries(): Array<[string, CallbackRoute]>;
}

function isCallbackRoute(value: unknown): value is CallbackRoute {
	if (!value || typeof value !== "object") return false;
	const route = value as Partial<CallbackRoute>;
	return (
		typeof route.sessionId === "string" &&
		typeof route.actionId === "string" &&
		(typeof route.answer === "string" || typeof route.answer === "number")
	);
}

/** Create a compact, durable callback alias table. Serialized data contains routing ids only. */
export function createAliasTable(): AliasTable {
	let next = 1;
	const routes = new Map<string, CallbackRoute>();
	return {
		put(route) {
			let alias: string;
			do {
				alias = `a${(next++).toString(36)}`;
			} while (routes.has(alias));
			if (Buffer.byteLength(alias, "utf8") > 64) throw new Error("callback alias exceeded Telegram limit");
			routes.set(alias, { ...route });
			return alias;
		},
		get(alias) {
			const route = routes.get(alias);
			return route ? { ...route } : undefined;
		},
		delete(alias) {
			return routes.delete(alias);
		},
		serialize() {
			return { version: 1, next, routes: Object.fromEntries(routes.entries()) };
		},
		load(json) {
			routes.clear();
			const data = typeof json === "string" ? JSON.parse(json) : json;
			if (!data || typeof data !== "object") return;
			const obj = data as { next?: unknown; routes?: unknown };
			if (typeof obj.next === "number" && Number.isFinite(obj.next) && obj.next > 0) next = Math.floor(obj.next);
			if (!obj.routes || typeof obj.routes !== "object" || Array.isArray(obj.routes)) return;
			for (const [alias, route] of Object.entries(obj.routes)) {
				if (Buffer.byteLength(alias, "utf8") <= 64 && isCallbackRoute(route)) routes.set(alias, { ...route });
			}
		},
		entries() {
			return Array.from(routes.entries()).map(([alias, route]) => [alias, { ...route }]);
		},
	};
}

/** Render an `action_needed` payload into a Telegram message. */
export function buildActionMessage(action: {
	kind: "ask" | "idle";
	id: string;
	question?: string;
	options?: string[];
	summary?: string;
}): RenderedMessage {
	if (action.kind === "idle") {
		const text = action.summary ? `🟢 Agent idle\n${escapeHtml(action.summary)}` : "🟢 Agent idle";
		return { text };
	}
	const text = `❓ ${bold(action.question ?? "Question")}`;
	const options = action.options ?? [];
	if (options.length === 0) return { text: `${text}\n\n(reply with text)` };
	const body = `${text}\n\n${numberedOptionList(options)}`;
	const inline_keyboard = buildCompactChoiceGrid(options, i => encodeCallbackData(action.id, i));
	return { text: body, inline_keyboard };
}

/** Send Telegram HTML text chunks sequentially so long messages preserve order. */
export async function sendTelegramHtmlChunks(
	send: TelegramSend,
	chatId: string,
	text: string,
	inlineKeyboard?: InlineButton[][],
): Promise<void> {
	const chunks = splitTelegramHtml(text);
	for (let i = 0; i < chunks.length; i++) {
		await send("sendMessage", {
			chat_id: chatId,
			text: chunks[i]!,
			parse_mode: TELEGRAM_PARSE_MODE,
			...(i === chunks.length - 1 && inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
		});
	}
}

/** A protocol `reply` frame the client should send to the server. */
export interface ReplyFrame {
	type: "reply";
	id: string;
	answer: number | string;
	token: string;
}

/**
 * Map a Telegram update into a reply frame, given the most recent pending ask id
 * (for free-text replies). Returns `null` when the update is not actionable.
 */
export function telegramUpdateToReply(
	update: unknown,
	token: string,
	latestPendingAskId: string | undefined,
): ReplyFrame | null {
	const u = update as {
		callback_query?: { data?: string };
		message?: { text?: string };
	};
	if (u.callback_query?.data) {
		const decoded = decodeCallbackData(u.callback_query.data);
		if (decoded) return { type: "reply", id: decoded.id, answer: decoded.index, token };
	}
	if (u.message?.text && latestPendingAskId) {
		return { type: "reply", id: latestPendingAskId, answer: u.message.text, token };
	}
	return null;
}

export type RouteDecision =
	| ({ kind: "reply" } & CallbackRoute)
	| { kind: "stale"; reason: string }
	| { kind: "ignore" };

export interface RouteInboundContext {
	aliasTable: Pick<AliasTable, "get">;
	messageRoutes: Map<string | number, CallbackRoute | Omit<CallbackRoute, "answer">>;
	pairedChatId: string;
}

type TelegramUpdateShape = {
	callback_query?: {
		id?: unknown;
		data?: unknown;
		message?: { chat?: { id?: unknown }; message_id?: unknown };
	};
	message?: {
		text?: unknown;
		chat?: { id?: unknown };
		message_id?: unknown;
		reply_to_message?: { message_id?: unknown };
	};
};

function updateChatId(update: TelegramUpdateShape): string | undefined {
	const id = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
	return id === undefined || id === null ? undefined : String(id);
}

function routeWithAnswer(route: CallbackRoute | Omit<CallbackRoute, "answer">, answer: number | string): CallbackRoute {
	return { sessionId: route.sessionId, actionId: route.actionId, answer };
}

/** Route a Telegram update to a session/action without I/O. Fail closed under ambiguity. */
export function routeInboundUpdate(update: unknown, ctx: RouteInboundContext): RouteDecision {
	const u = update as TelegramUpdateShape;
	if (updateChatId(u) !== String(ctx.pairedChatId)) return { kind: "ignore" };

	const callbackData = u.callback_query?.data;
	if (typeof callbackData === "string") {
		const route = ctx.aliasTable.get(callbackData);
		return route ? { kind: "reply", ...route } : { kind: "stale", reason: "unknown_alias" };
	}

	const text = typeof u.message?.text === "string" ? u.message.text : undefined;
	const replyTo = u.message?.reply_to_message?.message_id;
	if (replyTo !== undefined && text) {
		const route = ctx.messageRoutes.get(String(replyTo)) ?? ctx.messageRoutes.get(Number(replyTo));
		if (!route) return { kind: "stale", reason: "unknown_reply_message" };
		return { kind: "reply", ...routeWithAnswer(route, text) };
	}
	return { kind: "ignore" };
}

/** Read `{url, token, pid?, stale?}` from an endpoint discovery file. */
export function readEndpoint(path: string): { url: string; token: string; pid?: number; stale?: boolean } {
	const raw = JSON.parse(fs.readFileSync(path, "utf8")) as {
		url?: unknown;
		token?: unknown;
		pid?: unknown;
		stale?: unknown;
	};
	if (typeof raw.url !== "string" || typeof raw.token !== "string") {
		throw new Error(`invalid endpoint file: ${path}`);
	}
	return {
		url: raw.url,
		token: raw.token,
		pid: typeof raw.pid === "number" ? raw.pid : undefined,
		stale: raw.stale === true,
	};
}

/** Options for {@link runTelegramReferenceClient}. */
export interface TelegramReferenceOptions {
	botToken: string;
	chatId: string;
	endpointFile: string;
	apiBase?: string;
	fetchImpl?: typeof fetch;
}

/**
 * Run the reference bridge until the WebSocket closes. Sends `action_needed` to
 * the chat and forwards taps/text as replies. This is a minimal example loop;
 * production clients add reconnection, multi-chat routing, and persistence.
 */
export async function runTelegramReferenceClient(opts: TelegramReferenceOptions): Promise<void> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const apiBase = opts.apiBase ?? "https://api.telegram.org";
	const api = `${apiBase}/bot${opts.botToken}`;
	const { url, token } = readEndpoint(opts.endpointFile);

	const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	let latestPendingAskId: string | undefined;

	const send: TelegramSend = (method, body) =>
		fetchImpl(`${api}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	const handleServerMessage = async (data: string): Promise<void> => {
		const msg = JSON.parse(data) as {
			type: string;
			kind?: "ask" | "idle";
			id?: string;
			question?: string;
			options?: string[];
			summary?: string;
			reason?: string;
		};
		if (msg.type === "action_needed" && msg.id) {
			if (msg.kind === "ask") latestPendingAskId = msg.id;
			const rendered = buildActionMessage({
				kind: msg.kind ?? "ask",
				id: msg.id,
				question: msg.question,
				options: msg.options,
				summary: msg.summary,
			});
			await sendTelegramHtmlChunks(send, opts.chatId, rendered.text, rendered.inline_keyboard);
		} else if (msg.type === "action_resolved" && msg.id === latestPendingAskId) {
			latestPendingAskId = undefined;
		} else {
			// Threaded frames (identity/context/turn/config): render as plain messages
			// in this flat example client. The bundled daemon renders them into the
			// session's forum topic; this reference shows the minimal handling.
			const threaded = renderThreadedFrame(msg as never);
			if (threaded?.text) {
				await sendTelegramHtmlChunks(send, opts.chatId, threaded.text);
			}
		}
	};

	let messageQueue = Promise.resolve();
	ws.addEventListener("message", ev => {
		const data = String(ev.data);
		messageQueue = messageQueue.catch(() => undefined).then(() => handleServerMessage(data));
		void messageQueue.catch(() => undefined);
	});

	// Telegram long-poll loop.
	let offset = 0;
	let running = true;
	ws.addEventListener("close", () => {
		running = false;
	});

	while (running) {
		const res = await send("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
		const body = (await res.json()) as { result?: Array<{ update_id: number } & Record<string, unknown>> };
		for (const update of body.result ?? []) {
			offset = update.update_id + 1;
			const callbackId = (update as { callback_query?: { id?: unknown } }).callback_query?.id;
			if (typeof callbackId === "string") {
				void send("answerCallbackQuery", { callback_query_id: callbackId });
			}
			const reply = telegramUpdateToReply(update, token, latestPendingAskId);
			if (reply && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
		}
	}
}
