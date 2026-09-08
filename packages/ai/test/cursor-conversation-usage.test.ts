import { describe, expect, it } from "bun:test";

import { finalizeCursorUsageForTest, hashCursorUsageValueForTest } from "../src/providers/cursor";
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
});

describe("cursor usage-context hashing", () => {
	it("hashes tool definitions that carry bigint runtime identity fields", () => {
		const tools = [
			{
				name: "read",
				description: "read a file",
				runner: { sessionManager: { securityContext: { rootAuthority: { dev: 16777234n, ino: 257191361n } } } },
			},
		];

		expect(() => hashCursorUsageValueForTest(tools)).not.toThrow();
		expect(hashCursorUsageValueForTest(tools)).toBe(hashCursorUsageValueForTest(tools));
	});

	it("still separates tool sets that differ only in a bigint field", () => {
		const withDev = (dev: bigint) => [{ name: "read", runner: { rootAuthority: { dev } } }];

		expect(hashCursorUsageValueForTest(withDev(1n))).not.toBe(hashCursorUsageValueForTest(withDev(2n)));
	});

	it("hashes tool definitions holding executor closures and cycles", () => {
		const tool: Record<string, unknown> = { name: "bash", execute: async () => undefined };
		tool.self = tool;

		expect(() => hashCursorUsageValueForTest([tool])).not.toThrow();
		expect(hashCursorUsageValueForTest([tool])).not.toBe(hashCursorUsageValueForTest([{ name: "bash" }]));
	});
});
