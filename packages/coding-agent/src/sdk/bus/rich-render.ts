/**
 * Rich-message promotion for stable non-editable Telegram text sends.
 *
 * When enabled, the daemon promotes eligible finalized `sendMessage` payloads
 * carrying raw markdown to the Bot API `sendRichMessage` method. On any miss or
 * failure the daemon keeps the unchanged HTML `sendMessage` path, so the
 * off-state request bodies are byte-identical.
 */

import type { BotApi } from "./telegram-daemon";
import type { ThreadedSend } from "./threaded-render";

/**
 * Telegram's hard per-message character ceiling (4096). Surfaced here purely as
 * documentation and a marker for a future native rich-message splitter — it is
 * intentionally NON-BEHAVIORAL and MUST stay that way: nothing in the rich path
 * branches on this value.
 *
 * Overflow is already safe without it. The production final-answer text is capped
 * at 3500 chars upstream (`summaryFromMessage(..., 3500)`), so a promoted
 * `sendRichMessage` never approaches this ceiling; and if the Bot API ever rejects
 * an oversized rich payload it returns `{ ok: false }`, which
 * `deliverRichWithFallback` (below) turns into the chunked HTML `splitTelegramHtml`
 * fallback (each chunk ≤ TELEGRAM_MESSAGE_LIMIT). This constant only marks where a
 * future rich splitter would read its ceiling; wiring it into a branch would change
 * byte-for-byte behavior and is out of scope.
 */
export const RICH_MESSAGE_LIMIT = 4096;

/** Wrap raw markdown in the `sendRichMessage` request payload shape. */
export function buildRichMessage(
	raw: string,
	extras: { reply_markup?: unknown } = {},
): { rich_message: { markdown: string }; reply_markup?: unknown } {
	return { rich_message: { markdown: raw }, ...extras };
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
