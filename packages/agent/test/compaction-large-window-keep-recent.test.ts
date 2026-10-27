import { describe, expect, it } from "bun:test";
import {
	DEFAULT_AUTO_THRESHOLD_CEILING_TOKENS,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	resolveThresholdTokens,
} from "@gajae-code/agent-core/compaction/compaction";
import type { SessionEntry, SessionMessageEntry } from "@gajae-code/agent-core/compaction/entries";
import type { AssistantMessage } from "@gajae-code/ai/types";

const timestamp = "2026-06-12T00:00:00.000Z";
const timestampMs = Date.parse(timestamp);
const turnText = "recent context ".repeat(40);

function createUserEntry(id: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role: "user", content: turnText, timestamp: timestampMs },
	};
}

function createAssistantEntry(id: string): SessionMessageEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: turnText }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "keep-recent-test",
		stopReason: "stop",
		timestamp: timestampMs,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	return { type: "message", id, parentId: null, timestamp, message };
}

function createLongHistory(): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let turn = 0; turn < 1_200; turn++) {
		entries.push(createUserEntry(`user-${turn}`));
		entries.push(createAssistantEntry(`assistant-${turn}`));
	}
	return entries;
}

describe("compaction large-window keep-recent", () => {
	it("keeps a configured minimum without exceeding the production threshold across window sizes", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false };
		const history = createLongHistory();
		const contextWindows = [200_000, 400_000, 1_000_000, 2_000_000, 10_000_000, 20_000_000];

		for (const contextWindow of contextWindows) {
			const preparation = prepareCompaction(history, settings, { contextWindow });
			if (!preparation) throw new Error(`Expected compaction preparation for a ${contextWindow}-token window`);

			const keepRecentTokens = preparation.tokenCorrection.keepRecentTokensCorrected;
			expect(keepRecentTokens).toBeGreaterThanOrEqual(settings.keepRecentTokens);
			expect(keepRecentTokens).toBeLessThanOrEqual(resolveThresholdTokens(contextWindow, settings));
			if (contextWindow > 200_000) {
				expect(resolveThresholdTokens(contextWindow, settings)).toBe(DEFAULT_AUTO_THRESHOLD_CEILING_TOKENS);
			}
			if (contextWindow === 200_000) {
				// The uncapped origin/dev behavior scales the keep window to 30% here.
				expect(keepRecentTokens).toBe(60_000);
			}
		}
	});

	it("keeps a reserve's worth of headroom below the ceiling on windows whose reserve reaches it", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false };
		const history = createLongHistory();
		for (const contextWindow of [1_000_000, 2_000_000, 10_000_000, 20_000_000]) {
			const preparation = prepareCompaction(history, settings, { contextWindow });
			if (!preparation) throw new Error(`Expected compaction preparation for a ${contextWindow}-token window`);
			expect(preparation.tokenCorrection.keepRecentTokensCorrected).toBe(150_000);
		}
	});

	it("bounds configured keep floors above the ceiling below the threshold on 1M and 2M windows", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false, keepRecentTokens: 400_000 };
		const history = createLongHistory();
		for (const contextWindow of [1_000_000, 2_000_000]) {
			const preparation = prepareCompaction(history, settings, { contextWindow });
			if (!preparation) throw new Error(`Expected compaction preparation for a ${contextWindow}-token window`);

			const keepRecentTokens = preparation.tokenCorrection.keepRecentTokensCorrected;
			const threshold = resolveThresholdTokens(contextWindow, settings);
			expect(keepRecentTokens).toBeLessThanOrEqual(threshold);
			expect(keepRecentTokens).toBeLessThan(threshold);
			const expandedCorrection = prepareCompaction(history, settings, {
				contextWindow,
				tokenCorrectionRatio: 0.5,
			});
			if (!expandedCorrection)
				throw new Error(`Expected correction preparation for a ${contextWindow}-token window`);
			expect(expandedCorrection.tokenCorrection.keepRecentTokensCorrected).toBeLessThan(threshold);
			expect(preparation.messagesToSummarize.length).toBeGreaterThan(0);
		}
	});
});
