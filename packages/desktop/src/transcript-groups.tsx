import type { DesktopMessage, DesktopSession } from "@gajae-code/desktop-host/protocol";
import { Fragment, type ReactNode } from "react";

/** One rendered transcript entry. */
export interface TranscriptItem {
	/**
	 * Stable identity for the React key and the `data-transcript-message` scroll anchor:
	 * `tool:<callId>` for a call whose id is unique in the transcript, otherwise the message id.
	 */
	key: string;
	/** The entry's messages in transcript order. Each entry holds exactly one message. */
	messages: DesktopMessage[];
}

function transcriptKeys(messages: readonly DesktopMessage[]): string[] {
	const calls = new Map<string, number>();
	for (const message of messages) {
		const callId = message.tool?.callId;
		if (callId) calls.set(callId, (calls.get(callId) ?? 0) + 1);
	}
	return messages.map(message => {
		const callId = message.tool?.callId;
		return callId && calls.get(callId) === 1 ? `tool:${callId}` : message.id;
	});
}

/**
 * Entries for the newest `limit` messages. Keys are computed over the whole transcript, so an
 * entry's key never depends on how much history is rendered.
 */
export function groupTranscript(messages: readonly DesktopMessage[], limit: number): TranscriptItem[] {
	const keys = transcriptKeys(messages);
	const tail = messages.slice(-limit);
	const offset = messages.length - tail.length;
	return tail.map((message, index) => ({ key: keys[offset + index]!, messages: [message] }));
}

/** Index in `messages` of the first message of the entry whose key is `key`, or -1. */
export function transcriptAnchorIndex(messages: readonly DesktopMessage[], key: string): number {
	return transcriptKeys(messages).indexOf(key);
}

export interface TranscriptEntryProps {
	item: TranscriptItem;
	/** The conversation the entry belongs to. */
	session: DesktopSession;
	connected: boolean;
	renderMessage: (message: DesktopMessage) => ReactNode;
}

/** Renders one entry through `renderMessage`, message by message. */
export function TranscriptEntry({ item, renderMessage }: TranscriptEntryProps) {
	return item.messages.map(message => <Fragment key={message.id}>{renderMessage(message)}</Fragment>);
}
