import { describe, expect, it } from "bun:test";
import type { Message } from "@gajae-code/ai";
import { estimateMessageTokensHeuristic } from "../src/compaction/compaction";

const MIB = 1024 * 1024;

function userTextMessage(text: string): Message {
	return { role: "user", content: text } as Message;
}

function expectFastHeuristicEstimate(message: Message, maxMs: number): number {
	const start = performance.now();
	const tokens = estimateMessageTokensHeuristic(message);
	const elapsedMs = performance.now() - start;
	expect(tokens).toBeGreaterThan(0);
	expect(elapsedMs).toBeLessThan(maxMs);
	expect(tokens).toBe(estimateMessageTokensHeuristic(message));
	return tokens;
}

describe("oversized token-count guard red-team (G009 / W8 / F22)", () => {
	it("keeps boundary-sized and above-boundary messages cheap and deterministic", () => {
		const boundary = userTextMessage("a".repeat(2 * MIB));
		const above = userTextMessage("b".repeat(2 * MIB + 1));

		expectFastHeuristicEstimate(boundary, 1_000);
		expectFastHeuristicEstimate(above, 1_000);
	});

	it("bounds a huge 8 MiB message without hanging", () => {
		const huge = userTextMessage("h".repeat(8 * MIB));
		const tokens = expectFastHeuristicEstimate(huge, 1_000);
		expect(tokens).toBeLessThanOrEqual(Math.ceil((8 * MIB) / 4));
	});

	it("handles multi-block assistant text and thinking content deterministically", () => {
		const multiBlock = {
			role: "assistant",
			content: [
				{ type: "text", text: "t".repeat(MIB) },
				{ type: "thinking", thinking: "r".repeat(MIB) },
				{ type: "text", text: "u".repeat(64) },
			],
		} as unknown as Message;

		expectFastHeuristicEstimate(multiBlock, 1_000);
	});

	it("still returns a positive deterministic estimate for normal small content", () => {
		const small = userTextMessage("normal small message for heuristic token counting");
		expectFastHeuristicEstimate(small, 1_000);
	});
});
