import { describe, expect, it } from "bun:test";
import type { Message } from "@gajae-code/ai";
import { estimateMessageTokensHeuristic } from "../src/compaction/compaction";

describe("oversized token-count guard (W8 / F22)", () => {
	it("keeps a huge message cheap, positive, and deterministic without native token loading", () => {
		const huge = { role: "user", content: "x".repeat(3 * 1024 * 1024) } as Message;
		const start = performance.now();
		const first = estimateMessageTokensHeuristic(huge);
		const elapsedMs = performance.now() - start;
		const second = estimateMessageTokensHeuristic(huge);

		expect(first).toBeGreaterThan(0);
		expect(first).toBe(second);
		expect(elapsedMs).toBeLessThan(1_000);
	});

	it("still produces a positive deterministic heuristic count for a normal-sized message", () => {
		const small = { role: "user", content: "hello world, this is a normal message" } as Message;
		const first = estimateMessageTokensHeuristic(small);

		expect(first).toBeGreaterThan(0);
		expect(first).toBe(estimateMessageTokensHeuristic(small));
	});
});
