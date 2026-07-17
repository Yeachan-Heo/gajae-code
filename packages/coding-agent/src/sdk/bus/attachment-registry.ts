/**
 * Process-wide registry mapping a session id to a sink that delivers a local
 * file to the session's connected Telegram chat as a document. Registered by
 * the notifications extension; consumed by the telegram_send tool.
 */

/** Delivers a local file to the session's Telegram chat. */
export type TelegramFileSink = (file: { path: string; caption?: string }) => Promise<{ ok: boolean; error?: string }>;

const sinks = new Map<string, TelegramFileSink>();

/** Register `sink` for `sessionId`. Returns a disposer that clears it. */
export function registerTelegramFileSink(sessionId: string, sink: TelegramFileSink): () => void {
	sinks.set(sessionId, sink);
	return () => {
		if (sinks.get(sessionId) === sink) sinks.delete(sessionId);
	};
}

/** The Telegram file sink for `sessionId`, if one is registered. */
export function getTelegramFileSink(sessionId: string): TelegramFileSink | undefined {
	return sinks.get(sessionId);
}
