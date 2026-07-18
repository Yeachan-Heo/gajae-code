/**
 * Rich-message promotion for stable non-editable Telegram text sends.
 *
 * When enabled, the daemon promotes eligible finalized `sendMessage` payloads
 * carrying raw markdown to Bot API `sendRichMessage`. Only an explicit
 * `{ ok: false }` response selects the unchanged HTML path; ambiguous transport
 * outcomes remain single-attempt and never fall back.
 */

import { parseRichEligibility } from "./rich-document";
import type { BotApi } from "./telegram-daemon";
import type { ThreadedSend } from "./threaded-render";

/**
 * Telegram's hard per-message character ceiling (4096). Final-answer promotion
 * uses this value to keep oversized Markdown on the existing chunked HTML path.
 * `/btw` eligibility has its own 32,768-scalar route guard; only a definite
 * rich rejection may select the correlated HTML path.
 */
export const RICH_MESSAGE_LIMIT = 4096;

/** Wrap raw markdown in the `sendRichMessage` request payload shape. */
export function buildRichMessage(
	raw: string,
	extras: { reply_markup?: unknown } = {},
): { rich_message: { markdown: string; skip_entity_detection: true }; reply_markup?: unknown } {
	return { rich_message: { markdown: raw, skip_entity_detection: true }, ...extras };
}
/** Telegram message identifiers are strictly positive safe integers. */
function validMessageId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
/** Whether `/btw` Markdown may use Bot API 10.1 rich delivery. */
export function isBtwRichEligible(markdown: string): boolean {
	return parseRichEligibility(markdown).kind === "eligible";
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
 * Deliver the promoted rich message, falling back to `fallbackDeliver` only
 * after an explicit `{ ok: false }` response. Transport errors and malformed or
 * ambiguous responses are logged but never retried or sent again through HTML.
 */
export async function deliverRichWithFallback(
	botApi: BotApi,
	base: { chat_id: string | number; message_thread_id?: number },
	send: ThreadedSend,
	signal: AbortSignal,
	fallbackDeliver: () => Promise<void>,
	log?: { warn(msg: string): void },
): Promise<number | undefined> {
	try {
		const res = await botApi.call(
			"sendRichMessage",
			{ ...base, ...buildRichMessage(send.richMarkdown!) },
			{ noRetry: true, signal },
		);
		if (res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === false) {
			const description = (res as { description?: unknown }).description;
			const failure = typeof description === "string" && description.length > 0 ? description : "ok:false";
			log?.warn(`notifications: sendRichMessage rejected (${failure}); falling back to HTML`);
			await fallbackDeliver();
			return undefined;
		}
		const candidate = (res as { result?: { message_id?: unknown } } | null)?.result?.message_id;
		if (validMessageId(candidate)) return candidate;
		log?.warn("notifications: sendRichMessage outcome ambiguous; not falling back to HTML");
	} catch (err) {
		const failure = err instanceof Error ? err.message : String(err);
		log?.warn(`notifications: sendRichMessage failed (${failure}); not falling back to HTML`);
	}
	return undefined;
}

/**
 * Deliver an action-needed (ask/idle) message via `sendRichMessage`, falling
 * back to the unchanged HTML chunk loop only after an explicit `{ ok:false }`
 * response. Other outcomes are ambiguous, are logged, and preserve the single
 * physical rich delivery.
 */
export async function deliverRichActionWithFallback(
	botApi: BotApi,
	base: { chat_id: string | number; message_thread_id?: number },
	opts: { markdown: string; replyMarkup?: unknown },
	signal: AbortSignal,
	htmlFallback: () => Promise<number | undefined>,
	log?: { warn(msg: string): void },
): Promise<{ messageId?: number; usedRich: boolean; usedFallback: boolean }> {
	try {
		const res = await botApi.call(
			"sendRichMessage",
			{
				...base,
				...buildRichMessage(
					opts.markdown,
					opts.replyMarkup === undefined ? {} : { reply_markup: opts.replyMarkup },
				),
			},
			{ noRetry: true, signal },
		);
		if (res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === false) {
			const description = (res as { description?: unknown }).description;
			const failure = typeof description === "string" && description.length > 0 ? description : "ok:false";
			log?.warn(`notifications: sendRichMessage(action) rejected (${failure}); falling back to HTML`);
			const fallbackId = await htmlFallback();
			return { messageId: fallbackId, usedRich: false, usedFallback: true };
		}
		const candidate = (res as { result?: { message_id?: unknown } } | null)?.result?.message_id;
		if (validMessageId(candidate)) return { messageId: candidate, usedRich: true, usedFallback: false };
		log?.warn("notifications: sendRichMessage(action) outcome ambiguous; not falling back to HTML");
	} catch (err) {
		const failure = err instanceof Error ? err.message : String(err);
		log?.warn(`notifications: sendRichMessage(action) failed (${failure}); not falling back to HTML`);
	}
	return { messageId: undefined, usedRich: true, usedFallback: false };
}
