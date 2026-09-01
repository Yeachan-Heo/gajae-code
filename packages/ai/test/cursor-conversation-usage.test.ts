import { describe, expect, it } from "bun:test";

import type { Usage } from "../src/types";

import { finalizeCursorUsageForTest } from "../src/providers/cursor";

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
		expect(usage.totalTokens).toBe(21_594);
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

	it("never reports negative prompt tokens when output exceeds reported usage", () => {
		const usage = finalizeCursorUsageForTest(50, 91);

		expect(usage.input).toBe(0);
		expect(usage.totalTokens).toBe(91);
	});
});
