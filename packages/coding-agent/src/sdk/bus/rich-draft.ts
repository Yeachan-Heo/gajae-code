/**
 * Opt-in rich-draft streaming for a turn's in-progress preview.
 *
 * When the operator opts in (`richDraft.enabled`) the daemon streams LIVE turn
 * markdown to the Bot API `sendRichMessageDraft` method as a debounced preview.
 * Every failure is a harmless no-op (warn once, keep the daemon alive), and when
 * off no draft call is ever made — so the off-state request bodies stay
 * byte-identical.
 */

import type { BotApi } from "./telegram-daemon";
import type { ThreadedSend } from "./threaded-render";

/** Minimum gap between two draft sends for one session (debounce floor). */
export const DRAFT_DEBOUNCE_MS = 1_500;

/**
 * Wrap raw markdown + a monotonic draft id in the `sendRichMessageDraft` request
 * payload shape: mirrors `buildRichMessage`'s proven `rich_message.markdown`
 * content wrapper, with a top-level `draft_id` selecting the draft revision to
 * update (a routing param, like `message_thread_id`).
 */
export function buildRichDraft(draftId: number, raw: string): { draft_id: number; rich_message: { markdown: string } } {
	return { draft_id: draftId, rich_message: { markdown: raw } };
}

/**
 * Whether a granted send should stream a rich draft. Fail-closed: every clause
 * must hold, otherwise no draft is sent. Mirrors `shouldPromoteRich` but targets
 * the LIVE lane and the live-only `richDraftMarkdown` marker (set by
 * `renderThreadedFrame` for non-finalized turn frames).
 */
export function shouldStreamDraft(input: { enabled?: boolean; send: ThreadedSend }): boolean {
	const { enabled, send } = input;
	return (
		enabled === true &&
		send.method === "sendMessage" &&
		send.lane === "live" &&
		typeof send.richDraftMarkdown === "string" &&
		send.richDraftMarkdown.trim().length > 0
	);
}

/**
 * Per-session debounce + monotonic draft-id state for draft streaming. Skips a
 * draft when less than `debounceMs` has elapsed since the session's last SENT
 * draft (the rate-limit pool already coalesces live frames to the latest, so a
 * skipped frame is naturally superseded by the next one). `reset` clears a
 * session's window when its turn finalizes so the next turn starts fresh.
 */
export class DraftStreamState {
	readonly #debounceMs: number;
	readonly #lastSentAt = new Map<string, number>();
	/** Daemon-global monotonic draft id: unique across sessions so two sessions
	 * sharing one flat chat (no per-topic thread key) never collide on draft id. */
	#nextDraftId = 0;

	constructor(debounceMs: number = DRAFT_DEBOUNCE_MS) {
		this.#debounceMs = debounceMs;
	}

	/**
	 * If enough time has elapsed since the session's last draft, record `now` as
	 * the new last-sent time and return the next monotonic draft id; otherwise
	 * return `undefined` (debounced — the caller skips this frame).
	 */
	tryClaim(sessionId: string, now: number): number | undefined {
		const last = this.#lastSentAt.get(sessionId);
		if (last !== undefined && now - last < this.#debounceMs) return undefined;
		this.#lastSentAt.set(sessionId, now);
		const id = ++this.#nextDraftId;
		return id;
	}

	/** Clear a session's debounce window (called when its turn finalizes). The
	 * global draft id keeps incrementing so ids are never reused across turns. */
	reset(sessionId: string): void {
		this.#lastSentAt.delete(sessionId);
	}
}

/**
 * Best-effort delivery of a rich draft. Never throws and has no HTML fallback: a
 * draft is a purely additive preview, so on any failure (a thrown transport
 * error or an `{ ok: false }` JSON response — the transport returns `res.json()`
 * for JSON methods, so `ok:false` does not throw) it warns exactly once and
 * returns; the unchanged live HTML send still carries the content.
 */
export async function deliverDraft(
	botApi: BotApi,
	base: { chat_id: string | number; message_thread_id?: number },
	draftId: number,
	raw: string,
	log?: { warn(msg: string): void },
): Promise<void> {
	let failure: string | undefined;
	try {
		const res = await botApi.call("sendRichMessageDraft", { ...base, ...buildRichDraft(draftId, raw) });
		if (res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === false) {
			const description = (res as { description?: unknown }).description;
			failure = typeof description === "string" && description.length > 0 ? description : "ok:false";
		}
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
	if (failure !== undefined) log?.warn(`notifications: sendRichMessageDraft failed (${failure}); draft skipped`);
}
