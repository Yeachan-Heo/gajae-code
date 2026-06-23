/**
 * Fail-closed routing for inbound Telegram updates in threaded session mode.
 *
 * In the threaded surface, a free-text reply inside a session's forum topic
 * injects a new user turn into that session (steering it at any time). That is
 * remote control of the agent, so every inbound path must fail closed:
 *
 * - the update must come from the single paired chat id;
 * - it must carry a `message_thread_id` (topic) that maps to a KNOWN session;
 * - its `update_id` must not have been seen before (idempotency / replay guard);
 * - the text must be non-empty.
 *
 * Anything ambiguous or unmapped is ignored with a reason rather than guessed.
 * This module is pure (the dedupe set and topic map are injected) so the
 * security rules are exhaustively unit-testable without a live Bot API.
 */

/** Minimal shape of the inbound Telegram message we route on. */
export interface InboundUpdate {
	update_id?: unknown;
	message?: {
		message_id?: unknown;
		text?: unknown;
		caption?: unknown;
		photo?: unknown;
		document?: unknown;
		video?: unknown;
		audio?: unknown;
		voice?: unknown;
		animation?: unknown;
		chat?: { id?: unknown };
		message_thread_id?: unknown;
	};
}

/** A downloadable media attachment referenced by an inbound message. */
export interface InboundAttachment {
	/** Telegram file_id to resolve via getFile. */
	fileId: string;
	/** Source media kind; "photo" is always an image. */
	kind: "photo" | "document" | "video" | "audio" | "voice" | "animation";
	/** MIME type when Telegram provides one. */
	mime?: string;
	/** Original file name when provided. */
	fileName?: string;
}

/** Context for {@link decideThreadedInbound}. All lookups are injected. */
export interface ThreadedInboundCtx {
	/** The single paired chat id (string-compared). */
	pairedChatId: string;
	/** Resolve a topic/thread id to its owning session id, or undefined. */
	topicToSession: (threadId: string) => string | undefined;
	/** Whether this `update_id` has already been processed. */
	isDuplicate: (updateId: number) => boolean;
}

/** Outcome of routing an inbound update. */
export type ThreadedInboundDecision =
	| {
			kind: "inject";
			sessionId: string;
			text: string;
			updateId: number;
			threadId: string;
			messageId?: number;
			attachment?: InboundAttachment;
	  }
	| { kind: "duplicate"; updateId: number }
	| { kind: "ignore"; reason: string };

function asString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	return undefined;
}

function extractAttachment(message: NonNullable<InboundUpdate["message"]>): InboundAttachment | undefined {
	if (Array.isArray(message.photo) && message.photo.length > 0) {
		const photo = message.photo[message.photo.length - 1];
		if (photo && typeof photo === "object" && "file_id" in photo && typeof photo.file_id === "string") {
			return { fileId: photo.file_id, kind: "photo", mime: "image/jpeg" };
		}
	}

	for (const kind of ["document", "video", "audio", "voice", "animation"] as const) {
		const file = message[kind];
		if (file && typeof file === "object" && "file_id" in file && typeof file.file_id === "string") {
			return {
				fileId: file.file_id,
				kind,
				mime: "mime_type" in file && typeof file.mime_type === "string" ? file.mime_type : undefined,
				fileName: "file_name" in file && typeof file.file_name === "string" ? file.file_name : undefined,
			};
		}
	}

	return undefined;
}

/**
 * Decide whether an inbound update should inject a user turn. Fail-closed:
 * returns `ignore` (with a reason) or `duplicate` for anything that is not an
 * unambiguous, first-seen, paired-chat, known-topic text message.
 */
export function decideThreadedInbound(update: InboundUpdate, ctx: ThreadedInboundCtx): ThreadedInboundDecision {
	const message = update.message;
	if (!message) return { kind: "ignore", reason: "no_message" };

	const chatId = asString(message.chat?.id);
	if (chatId === undefined || chatId !== String(ctx.pairedChatId)) {
		return { kind: "ignore", reason: "wrong_chat" };
	}

	const threadId = asString(message.message_thread_id);
	if (threadId === undefined) return { kind: "ignore", reason: "no_topic" };

	const sessionId = ctx.topicToSession(threadId);
	if (sessionId === undefined) return { kind: "ignore", reason: "unknown_topic" };

	if (typeof update.update_id !== "number") return { kind: "ignore", reason: "missing_update_id" };
	const updateId = update.update_id;
	if (ctx.isDuplicate(updateId)) return { kind: "duplicate", updateId };

	const text =
		typeof message.text === "string"
			? message.text.trim()
			: typeof message.caption === "string"
				? message.caption.trim()
				: "";
	const attachment = extractAttachment(message);
	if (!text && attachment === undefined) return { kind: "ignore", reason: "empty_text" };

	const messageId = typeof message.message_id === "number" ? message.message_id : undefined;
	return { kind: "inject", sessionId, text, updateId, threadId, messageId, attachment };
}
