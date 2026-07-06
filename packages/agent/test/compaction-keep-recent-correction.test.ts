import { describe, expect, test } from "bun:test";
import type { CompactionSettings } from "@gajae-code/agent-core/compaction/compaction";
import {
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	TOKEN_CORRECTION_MAX_RATIO,
	TOKEN_CORRECTION_MIN_RATIO,
} from "@gajae-code/agent-core/compaction/compaction";
import type { SessionEntry, SessionMessageEntry } from "@gajae-code/agent-core/compaction/entries";
import type { AssistantMessage, Usage } from "@gajae-code/ai/types";

const timestamp = "2026-06-12T00:00:00.000Z";
const ts = Date.parse(timestamp);

// ~10 heuristic tokens (~40 chars) of text per line.
function line(i: number): string {
	return `entry-${i} alpha beta gamma delta epsilon`;
}

function userEntry(id: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role: "user", content: text, timestamp: ts },
	} as SessionMessageEntry;
}

function assistantEntry(id: string, text: string, usage?: Usage): SessionMessageEntry {
	const message = {
		role: "assistant",
		content: text,
		stopReason: "stop",
		timestamp: ts,
		...(usage ? { usage } : {}),
	} as unknown as AssistantMessage;
	return { type: "message", id, parentId: null, timestamp, message } as SessionMessageEntry;
}

function makeUsage(input: number): Usage {
	return { input, output: 10, cacheRead: 0, cacheWrite: 0 } as Usage;
}

/** 40 alternating turns; last assistant carries usage. */
function buildEntries(lastUsageInput = 500): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 40; i++) {
		entries.push(userEntry(`u${i}`, line(i)));
		const isLast = i === 39;
		entries.push(assistantEntry(`a${i}`, line(i), isLast ? makeUsage(lastUsageInput) : undefined));
	}
	return entries;
}

function settings(keepRecentTokens: number): CompactionSettings {
	return { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens, remoteEnabled: false };
}

describe("prepareCompaction keep-window token correction (Finding 7)", () => {
	test("no supplied ratio leaves keepRecentTokens uncorrected — the raw prompt quotient is never used", () => {
		// A huge provider promptTokens would have massively shrunk the window under
		// the old confounded promptTokens/estimatedTokens quotient. It must not now.
		const prep = prepareCompaction(buildEntries(1_000_000), settings(100));
		expect(prep).toBeDefined();
		expect(prep?.tokenCorrection.ratio).toBe(1);
		expect(prep?.tokenCorrection.keepRecentTokensCorrected).toBe(100);
	});

	test("ratio > 1 (heuristic underestimates) shrinks the kept window so it still compacts", () => {
		const prep = prepareCompaction(buildEntries(), settings(100), { tokenCorrectionRatio: 2 });
		expect(prep?.tokenCorrection.ratio).toBe(2);
		expect(prep?.tokenCorrection.keepRecentTokensCorrected).toBe(50);
	});

	test("2x overestimate (ratio 0.5) grows the kept window to ~the configured real budget", () => {
		const prep = prepareCompaction(buildEntries(), settings(100), { tokenCorrectionRatio: 0.5 });
		expect(prep?.tokenCorrection.ratio).toBe(0.5);
		expect(prep?.tokenCorrection.keepRecentTokensCorrected).toBe(200);
	});

	test("correction is bidirectional: a smaller kept window keeps fewer recent messages than a larger one", () => {
		const shrink = prepareCompaction(buildEntries(), settings(100), { tokenCorrectionRatio: 2 });
		const grow = prepareCompaction(buildEntries(), settings(100), { tokenCorrectionRatio: 0.5 });
		expect(shrink?.recentMessages.length).toBeLessThan(grow?.recentMessages.length ?? 0);
	});

	test("ratio is clamped to [0.5, 2] in both directions", () => {
		const high = prepareCompaction(buildEntries(), settings(100), { tokenCorrectionRatio: 10 });
		expect(high?.tokenCorrection.ratio).toBe(TOKEN_CORRECTION_MAX_RATIO);
		expect(high?.tokenCorrection.keepRecentTokensCorrected).toBe(50);

		const low = prepareCompaction(buildEntries(), settings(100), { tokenCorrectionRatio: 0.01 });
		expect(low?.tokenCorrection.ratio).toBe(TOKEN_CORRECTION_MIN_RATIO);
		expect(low?.tokenCorrection.keepRecentTokensCorrected).toBe(200);
	});

	test("invalid ratios (0, negative, NaN) fall back to no correction", () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const prep = prepareCompaction(buildEntries(), settings(100), { tokenCorrectionRatio: bad });
			expect(prep?.tokenCorrection.ratio).toBe(1);
			expect(prep?.tokenCorrection.keepRecentTokensCorrected).toBe(100);
		}
	});
});
