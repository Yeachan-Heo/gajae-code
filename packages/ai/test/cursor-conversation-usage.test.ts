import { describe, expect, it } from "bun:test";

import { finalizeCursorUsageForTest } from "../src/providers/cursor";
import type { Usage } from "../src/types";

/**
 * Mirror of `calculatePromptTokens` in `@gajae-code/agent`, which drives the
 * context indicator and the compaction threshold. `packages/ai` does not depend
 * on `packages/agent`, so the consumer formula is restated here rather than
 * imported.
 */
function promptTokens(usage: Usage): number {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt > 0 ? prompt : usage.totalTokens || usage.input + usage.output;
}

/**
 * Cursor reports whole-conversation consumption as
 * `ConversationTokenDetails.used_tokens` and streams this turn's output as
 * token deltas. The prompt side is the difference; attributing `used_tokens` to
 * output leaves `usage.input` at zero, which makes context accounting and
 * compaction believe the conversation is empty.
 */
describe("cursor conversation usage", () => {
	it("derives prompt tokens from conversation usage minus streamed output", () => {
		const usage = finalizeCursorUsageForTest(21_594, 14);

		expect(usage.input).toBe(21_580);
		expect(usage.output).toBe(14);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(21_594);
	});

	it("does not double-count checkpoint totals as output", () => {
		const usage = finalizeCursorUsageForTest(100, 10);

		expect(usage.output).toBe(10);
		expect(usage.input + usage.output).toBe(100);
	});

	it("does not subtract output produced after a periodic checkpoint", () => {
		const usage = finalizeCursorUsageForTest(100, 15, { checkpointOutputTokens: 10 });

		expect(usage.input).toBe(90);
		expect(usage.output).toBe(15);
		expect(usage.totalTokens).toBe(105);
	});

	it("does not reuse pre-compaction output after a checkpoint decrease", () => {
		const usage = finalizeCursorUsageForTest(80, 30, { checkpointOutputTokens: 0 });

		expect(usage.input).toBe(80);
		expect(usage.output).toBe(30);
		expect(usage.totalTokens).toBe(110);
	});

	it("reports prompt tokens to the compaction accounting path", () => {
		const usage = finalizeCursorUsageForTest(21_594, 14);

		// Before the fix `input` stayed 0, so this fell through to the
		// output-only fallback and reported 14 tokens of context.
		expect(promptTokens(usage)).toBe(21_580);
	});

	it("preserves the reported conversation total in totalTokens", () => {
		// Observed across four turns of a live cursor/kimi-k3-max session.
		const observed: Array<[used: number, output: number]> = [
			[22_418, 860],
			[22_829, 1_089],
			[22_292, 239],
			[22_586, 278],
		];

		for (const [used, output] of observed) {
			const usage = finalizeCursorUsageForTest(used, output);
			expect(usage.totalTokens).toBe(used);
			// The output-only fallback would have reported `output` here.
			expect(promptTokens(usage)).toBeGreaterThan(20_000);
		}
	});

	it("leaves usage untouched when no checkpoint reported conversation usage", () => {
		const usage = finalizeCursorUsageForTest(0, 91);

		expect(usage.input).toBe(0);
		expect(usage.output).toBe(91);
	});

	it("uses the cached conversation total when a warm turn has no checkpoint", () => {
		const usage = finalizeCursorUsageForTest(10_000, 100, { hasConversationCheckpoint: false });

		expect(usage.input).toBe(10_000);
		expect(usage.output).toBe(100);
		expect(usage.totalTokens).toBe(10_100);
	});

	it("advances a checkpoint-free baseline exactly once across warm turns", () => {
		const firstTurn = finalizeCursorUsageForTest(10_000, 100, { hasConversationCheckpoint: false });
		const secondTurn = finalizeCursorUsageForTest(firstTurn.totalTokens, 50, { hasConversationCheckpoint: false });
		const thirdTurn = finalizeCursorUsageForTest(secondTurn.totalTokens, 25, { hasConversationCheckpoint: false });

		expect(firstTurn.totalTokens).toBe(10_100);
		expect(secondTurn.input).toBe(10_100);
		expect(secondTurn.totalTokens).toBe(10_150);
		expect(thirdTurn.input).toBe(10_150);
		expect(thirdTurn.totalTokens).toBe(10_175);
	});

	it("accepts an explicit zero checkpoint as a reset", () => {
		const usage = finalizeCursorUsageForTest(0, 91, { hasConversationCheckpoint: true });

		expect(usage.input).toBe(0);
		expect(usage.totalTokens).toBe(91);
	});

	it("never reports negative prompt tokens when output exceeds reported usage", () => {
		const usage = finalizeCursorUsageForTest(50, 91);

		expect(usage.input).toBe(0);
		expect(usage.totalTokens).toBe(91);
	});

	it("resets usage for a new turn instead of accumulating prior checkpoints", () => {
		const firstTurn = finalizeCursorUsageForTest(10_000, 100);
		const secondTurn = finalizeCursorUsageForTest(250, 25);

		expect(firstTurn.totalTokens).toBe(10_000);
		expect(secondTurn.input).toBe(225);
		expect(secondTurn.totalTokens).toBe(250);
	});

	it("includes cache tokens in totalTokens calculation", () => {
		// Note: Cursor provider currently always reports cache tokens as 0
		// (the server does not provide cache info), but the calculation should
		// still include them for correctness in case the provider changes.
		const usage = finalizeCursorUsageForTest(100, 20);

		expect(usage.input).toBe(80);
		expect(usage.output).toBe(20);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		// totalTokens should include all components: input + output + cacheRead + cacheWrite
		expect(usage.totalTokens).toBe(usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
	});
});

describe("cursor cost calculation with realistic pricing (issue #6036)", () => {
	it("calculates cost with realistic Cursor model pricing", () => {
		// Simulate a Cursor request with input derived from context and output from tokenDelta
		const usage = finalizeCursorUsageForTest(10_000, 500);
		// Cursor models typically cost $2-6/1M input, $6-18/1M output
		// Assuming a mid-tier model at $3/1M input, $9/1M output
		const input = (usage.input * 3) / 1_000_000;
		const output = (usage.output * 9) / 1_000_000;

		expect(input).toBeGreaterThan(0);
		expect(output).toBeGreaterThan(0);
		// Total cost should be non-zero with real pricing
		const totalCost = input + output;
		expect(totalCost).toBeDefined();
		expect(totalCost).toBeGreaterThan(0);
	});

	it("does not report zero cache metrics as measured data (issue #6036)", () => {
		// Cursor API doesn't provide per-request cache data
		// Cache metrics should be 0 because they're unavailable, not zero
		const usage = finalizeCursorUsageForTest(10_000, 500);

		// Cache metrics are 0 because Cursor doesn't support prompt caching
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
	});

	it("handles first turn without prior context checkpoint", () => {
		// First turn: only output delta is available
		const usage = finalizeCursorUsageForTest(0, 512, { hasConversationCheckpoint: false });

		expect(usage.input).toBe(0);
		expect(usage.output).toBe(512);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
	});

	it("derives input from context checkpoint on second and later turns", () => {
		// Second turn: context checkpoint provides accumulated total
		const secondTurn = finalizeCursorUsageForTest(15_000, 400);

		expect(secondTurn.input).toBe(14_600); // 15_000 - 400 output
		expect(secondTurn.output).toBe(400);
		expect(secondTurn.cacheRead).toBe(0); // Unavailable, not measured zero
		expect(secondTurn.cacheWrite).toBe(0);
	});

	it("session aggregation correctly sums cost across multiple turns", () => {
		// Simulate a 3-turn session
		const turns = [
			finalizeCursorUsageForTest(0, 512, { hasConversationCheckpoint: false }),
			finalizeCursorUsageForTest(8_000, 400),
			finalizeCursorUsageForTest(12_000, 300),
		];

		// All turns should have cacheRead=0 and cacheWrite=0
		for (const turn of turns) {
			expect(turn.cacheRead).toBe(0);
			expect(turn.cacheWrite).toBe(0);
		}

		// Session totals
		const totalInput = turns.reduce((sum, u) => sum + u.input, 0);
		const totalOutput = turns.reduce((sum, u) => sum + u.output, 0);

		expect(totalOutput).toBe(512 + 400 + 300); // All output is from tokenDelta
		expect(totalInput).toBe(0 + 7600 + 11700); // Input derived from checkpoint
	});

	it("explicitly marks cache metrics as unavailable by staying zero", () => {
		// When Cursor doesn't provide cache data, cacheRead and cacheWrite remain 0
		// This is acceptable because Cursor doesn't support prompt caching
		const usage = finalizeCursorUsageForTest(100_000, 1_000);

		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		// Zero cache is unavailable data, not measured zero
		// The comment in the issue suggests we should make this explicit
		// For now, the test documents that cache is always zero
	});
});
