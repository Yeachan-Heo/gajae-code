import { describe, expect, it } from "bun:test";
import type { Message } from "@gajae-code/ai";
import { estimateMessageTokensHeuristic, estimateTokens } from "../src/compaction/compaction";

describe("oversized token-count guard (W8 / F22)", () => {
	it("falls back to the cheap heuristic for a message above the native-tokenize cap (no sync BPE freeze)", () => {
		const huge = { role: "user", content: "x".repeat(3 * 1024 * 1024) } as Message;
		const native = estimateTokens(huge);
		const heuristic = estimateMessageTokensHeuristic(huge);
		// Above the 2 MiB cap the native path returns the heuristic, so the two agree closely
		// and the ~39MB BPE tokenizer is never invoked (the call returns immediately).
		expect(native).toBeGreaterThan(0);
		expect(Math.abs(native - heuristic) / heuristic).toBeLessThan(0.2);
	});

	it("still produces a positive native count for a normal-sized message", () => {
		const small = { role: "user", content: "hello world, this is a normal message" } as Message;
		expect(estimateTokens(small)).toBeGreaterThan(0);
	});
});
