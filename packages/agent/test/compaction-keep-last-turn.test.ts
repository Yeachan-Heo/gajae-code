import { describe, expect, test } from "bun:test";
import { estimateEntryTokens, findCutPoint } from "@gajae-code/agent-core/compaction/compaction";
import type { SessionEntry, SessionMessageEntry } from "@gajae-code/agent-core/compaction/entries";
import type { AssistantMessage } from "@gajae-code/ai/types";

const timestamp = "2026-06-12T00:00:00.000Z";
const ts = Date.parse(timestamp);

function userEntry(id: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role: "user", content: text, timestamp: ts },
	} as SessionMessageEntry;
}

function assistantEntry(id: string, text: string): SessionMessageEntry {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: ts,
	} as unknown as AssistantMessage;
	return { type: "message", id, parentId: null, timestamp, message } as SessionMessageEntry;
}

const body = "alpha beta gamma delta epsilon zeta eta theta";

describe("findCutPoint keeps the most-recent turn verbatim", () => {
	test("cut inside the most-recent turn snaps back to the turn start (no split)", () => {
		// turns: [u0 a0] [u1 a1 a2]. The most-recent turn is u1/a1/a2 and there is no
		// later user message after u1, so a mid-turn cut here would summarize u1 away.
		const entries: SessionEntry[] = [
			userEntry("u0", body),
			assistantEntry("a0", body),
			userEntry("u1", body),
			assistantEntry("a1", body),
			assistantEntry("a2", body),
		];

		// keepRecentTokens = 1 forces the token walk to stop at the newest message (a2, idx 4),
		// landing the raw cut on an assistant message inside the most-recent turn.
		const cut = findCutPoint(entries, 0, entries.length, 1);

		// Fixed behavior: snap to u1 (idx 2) and keep the whole turn instead of splitting it.
		expect(cut.isSplitTurn).toBe(false);
		expect(cut.firstKeptEntryIndex).toBe(2);
		expect(cut.turnStartIndex).toBe(-1);
	});

	test("cut inside an older turn still splits (later user message exists)", () => {
		// turns: [u0 a0 a1] [u1 a2]. A cut on a1 (older turn) has a later user message (u1),
		// so it must still split and summarize the older turn's prefix as before.
		const entries: SessionEntry[] = [
			userEntry("u0", body),
			assistantEntry("a0", body),
			assistantEntry("a1", body),
			userEntry("u1", body),
			assistantEntry("a2", body),
		];

		// Stop the walk exactly at a1 (idx 2): budget = tokens(a2) + tokens(u1) + 1.
		const keepRecentTokens = estimateEntryTokens(entries[4]) + estimateEntryTokens(entries[3]) + 1;
		const cut = findCutPoint(entries, 0, entries.length, keepRecentTokens);

		expect(cut.isSplitTurn).toBe(true);
		expect(cut.firstKeptEntryIndex).toBe(2);
		expect(cut.turnStartIndex).toBe(0);
	});
});
