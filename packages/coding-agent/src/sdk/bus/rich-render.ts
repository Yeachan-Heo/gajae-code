/**
 * Rich-message promotion for stable non-editable Telegram text sends.
 *
 * When enabled, the daemon promotes eligible finalized `sendMessage` payloads
 * carrying raw markdown to the Bot API `sendRichMessage` method. On any miss or
 * failure the daemon keeps the unchanged HTML `sendMessage` path, so the
 * off-state request bodies are byte-identical.
 */

import { Marked, type Token, type Tokens } from "marked";
import type { BotApi } from "./telegram-daemon";
import type { ThreadedSend } from "./threaded-render";

/**
 * Telegram's hard per-message character ceiling (4096). Final-answer promotion
 * uses this value to keep oversized Markdown on the existing chunked HTML path.
 * `/btw` delivery has its own 32,768-character route guard and otherwise lets
 * `sendRichMessage` fall back to HTML when Telegram rejects a rich payload.
 */
export const RICH_MESSAGE_LIMIT = 4096;

/** Wrap raw markdown in the `sendRichMessage` request payload shape. */
export function buildRichMessage(
	raw: string,
	extras: { reply_markup?: unknown } = {},
): { rich_message: { markdown: string }; reply_markup?: unknown } {
	return { rich_message: { markdown: raw }, ...extras };
}
type BtwRichText = string | BtwRichText[] | { type: "bold" | "italic" | "strikethrough" | "code"; text: BtwRichText };

type BtwRichCell = {
	text: BtwRichText;
	align?: "left" | "center" | "right";
	valign: "top";
	is_header?: true;
};

type BtwRichTableBlock = { type: "table"; cells: BtwRichCell[][] };

type BtwRichBlock =
	| { type: "heading"; text: BtwRichText; size: number }
	| { type: "paragraph"; text: BtwRichText }
	| BtwRichTableBlock;

const btwMarked = new Marked({ async: false, breaks: false, gfm: true, pedantic: false, silent: false });

function buildBtwRichText(tokens: Token[], depth: number): BtwRichText[] | undefined {
	if (depth > 16) return undefined;
	const text: BtwRichText[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case "text":
				text.push(token.text);
				break;
			case "br":
				text.push("\n");
				break;
			case "codespan":
				text.push({ type: "code", text: token.text });
				break;
			case "strong":
				{
					if (token.tokens === undefined) return undefined;
					const nested = buildBtwRichText(token.tokens, depth + 1);
					if (nested === undefined) return undefined;
					text.push({ type: "bold", text: nested });
				}
				break;
			case "em":
				{
					if (token.tokens === undefined) return undefined;
					const nested = buildBtwRichText(token.tokens, depth + 1);
					if (nested === undefined) return undefined;
					text.push({ type: "italic", text: nested });
				}
				break;
			case "del":
				{
					if (token.tokens === undefined) return undefined;
					const nested = buildBtwRichText(token.tokens, depth + 1);
					if (nested === undefined) return undefined;
					text.push({ type: "strikethrough", text: nested });
				}
				break;
			default:
				return undefined;
		}
	}
	return text;
}

function buildBtwTable(token: Tokens.Table, depth: number): BtwRichTableBlock | undefined {
	const columns = token.header.length;
	if (
		columns < 1 ||
		columns > 20 ||
		token.align.length !== columns ||
		token.rows.some(row => row.length !== columns) ||
		token.align.some(align => align !== "left" && align !== "center" && align !== "right" && align !== null)
	)
		return undefined;

	const buildRow = (row: Tokens.TableCell[], isHeader: boolean): BtwRichCell[] | undefined => {
		const cells: BtwRichCell[] = [];
		for (let column = 0; column < columns; column++) {
			const text = buildBtwRichText(row[column].tokens, depth + 1);
			const align = token.align[column];
			if (text === undefined) return undefined;
			cells.push({
				text,
				...(align === null ? {} : { align }),
				valign: "top",
				...(isHeader ? { is_header: true } : {}),
			});
		}
		return cells;
	};

	const header = buildRow(token.header, true);
	if (header === undefined) return undefined;
	const cells = [header];
	for (const row of token.rows) {
		const cellsRow = buildRow(row, false);
		if (cellsRow === undefined) return undefined;
		cells.push(cellsRow);
	}
	return { type: "table", cells };
}

/** Compile conservative complete `/btw` documents to native Telegram rich blocks. */
export function buildBtwRichBlocks(markdown: string): BtwRichBlock[] | undefined {
	let tokens: Token[];
	try {
		tokens = btwMarked.lexer(markdown);
	} catch {
		return undefined;
	}

	const blocks: BtwRichBlock[] = [];
	let units = 0;
	let hasTable = false;
	for (const token of tokens) {
		if (token.type === "space") continue;
		if (token.type === "heading") {
			if (token.tokens === undefined) return undefined;
			const text = buildBtwRichText(token.tokens, 2);
			if (text === undefined || token.depth < 1 || token.depth > 6) return undefined;
			blocks.push({ type: "heading", text, size: token.depth });
			units++;
			continue;
		}
		if (token.type === "paragraph" || token.type === "text") {
			let inlineTokens: Token[];
			if (token.type === "paragraph") {
				if (token.tokens === undefined) return undefined;
				inlineTokens = token.tokens;
			} else {
				inlineTokens = [token];
			}
			const text = buildBtwRichText(inlineTokens, 2);
			if (text === undefined) return undefined;
			blocks.push({ type: "paragraph", text });
			units++;
			continue;
		}
		if (token.type !== "table") return undefined;
		const table = buildBtwTable(token as Tokens.Table, 1);
		if (table === undefined) return undefined;
		units += 1 + table.cells.length;
		if (units > 500) return undefined;
		blocks.push(table);
		hasTable = true;
	}
	return hasTable && units <= 500 ? blocks : undefined;
}

/** Deliver `/btw` rich blocks or original Markdown, with one unchanged HTML fallback on failure. */
export async function deliverBtwRichWithFallback(
	botApi: BotApi,
	base: { chat_id: string | number; message_thread_id?: number },
	markdown: string,
	fallbackDeliver: () => Promise<void>,
	log?: { warn(msg: string): void },
): Promise<void> {
	const blocks = buildBtwRichBlocks(markdown);
	let failure: string | undefined;
	try {
		const res = await botApi.call("sendRichMessage", {
			...base,
			rich_message: blocks === undefined ? { markdown } : { blocks, skip_entity_detection: true },
		});
		if (res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === false) {
			const description = (res as { description?: unknown }).description;
			failure = typeof description === "string" && description.length > 0 ? description : "ok:false";
		}
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
	if (failure === undefined) return;
	log?.warn(`notifications: sendRichMessage(/btw) failed (${failure}); falling back to HTML`);
	await fallbackDeliver();
}

/**
 * Whether a granted send should be promoted to `sendRichMessage`. Fail-closed
 * and class-aware: every clause must hold, otherwise the daemon keeps the HTML path.
 */
export function shouldPromoteRich(input: { enabled?: boolean; send: ThreadedSend }): boolean {
	const { enabled, send } = input;
	return (
		enabled === true &&
		send.method === "sendMessage" &&
		send.lane === "finalized" &&
		send.richClass === "final" &&
		send.editable !== true &&
		typeof send.richMarkdown === "string" &&
		send.richMarkdown.trim().length > 0 &&
		send.richMarkdown.length <= RICH_MESSAGE_LIMIT &&
		typeof send.text === "string" &&
		send.text.length > 0
	);
}

/**
 * Deliver the promoted rich message, falling back to `fallbackDeliver` (the
 * unchanged HTML `sendMessage` loop) on any failure. A failure is either a
 * thrown transport error or a `{ ok: false }` JSON response (the transport
 * returns `res.json()` for JSON methods, so `ok:false` does not throw). On
 * failure exactly one diagnostic is logged before the fallback runs; on success
 * the fallback never runs.
 *
 * Returns the sent message's `message_id` on success (when the response carries
 * one), otherwise `undefined` — including every failure/fallback path and a
 * success whose response omits `result.message_id`. Callers that ignore the
 * return value are unaffected.
 */
export async function deliverRichWithFallback(
	botApi: BotApi,
	base: { chat_id: string | number; message_thread_id?: number },
	send: ThreadedSend,
	fallbackDeliver: () => Promise<void>,
	log?: { warn(msg: string): void },
): Promise<number | undefined> {
	let failure: string | undefined;
	let messageId: number | undefined;
	try {
		const res = await botApi.call("sendRichMessage", { ...base, ...buildRichMessage(send.richMarkdown!) });
		if (res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === false) {
			const description = (res as { description?: unknown }).description;
			failure = typeof description === "string" && description.length > 0 ? description : "ok:false";
		} else {
			const candidate = (res as { result?: { message_id?: unknown } } | null)?.result?.message_id;
			if (typeof candidate === "number") messageId = candidate;
		}
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
	if (failure === undefined) return messageId;
	log?.warn(`notifications: sendRichMessage failed (${failure}); falling back to HTML`);
	await fallbackDeliver();
	return undefined;
}

/**
 * Deliver an action-needed (ask/idle) message via `sendRichMessage`, falling
 * back to the unchanged HTML chunk loop on any failure. Mirrors
 * {@link deliverRichWithFallback} but takes an explicit markdown body plus an
 * optional top-level `reply_markup` (probe-confirmed: `sendRichMessage` accepts
 * `reply_markup` alongside `rich_message`), and surfaces a structured outcome so
 * the daemon can route inbound replies to the resulting message id.
 *
 * On rich success: returns `{ messageId, usedRich: true, usedFallback: false }`
 * where `messageId` is `res.result.message_id` when present. On a `{ ok:false }`
 * response or a thrown transport error: warns exactly once, runs `htmlFallback`,
 * and returns `{ messageId, usedRich: false, usedFallback: true }` where
 * `messageId` is the fallback's return value (the last HTML chunk's id).
 */
export async function deliverRichActionWithFallback(
	botApi: BotApi,
	base: { chat_id: string | number; message_thread_id?: number },
	opts: { markdown: string; replyMarkup?: unknown; requireMessageId?: boolean },
	htmlFallback: () => Promise<number | undefined>,
	log?: { warn(msg: string): void },
): Promise<{ messageId?: number; usedRich: boolean; usedFallback: boolean }> {
	let failure: string | undefined;
	let messageId: number | undefined;
	try {
		const res = await botApi.call("sendRichMessage", {
			...base,
			...buildRichMessage(opts.markdown, opts.replyMarkup === undefined ? {} : { reply_markup: opts.replyMarkup }),
		});
		if (res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === false) {
			const description = (res as { description?: unknown }).description;
			failure = typeof description === "string" && description.length > 0 ? description : "ok:false";
		} else {
			const candidate = (res as { result?: { message_id?: unknown } } | null)?.result?.message_id;
			if (typeof candidate === "number") messageId = candidate;
			// Ask messages MUST be reply-routable: if a rich success carries no numeric
			// message_id, fall back to HTML so a routable id is guaranteed.
			else if (opts.requireMessageId) failure = "rich response missing message_id";
		}
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
	if (failure === undefined) return { messageId, usedRich: true, usedFallback: false };
	log?.warn(`notifications: sendRichMessage(action) failed (${failure}); falling back to HTML`);
	const fallbackId = await htmlFallback();
	return { messageId: fallbackId, usedRich: false, usedFallback: true };
}
