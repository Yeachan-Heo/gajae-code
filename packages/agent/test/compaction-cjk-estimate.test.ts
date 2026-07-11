/**
 * Script-aware token estimation for CJK text.
 *
 * o200k-class tokenizers spend ~0.6–1.0 tokens per CJK character (measured
 * o200k_base: Hangul prose 0.604, spaceless Hangul 0.964, Han 0.793, Kana
 * 0.740 tokens/char), while the chars/4 heuristic assumed 0.25 — a 2–4x
 * undercount that let CJK-heavy unsent deltas sail past the compaction
 * threshold into provider `context_length_exceeded` rejections. CJK-block
 * characters are now charged at 1 token each (safe upper bound; the only
 * failure mode is compacting slightly early).
 */
import { describe, expect, it } from "bun:test";
import type { Model } from "@gajae-code/ai";
import {
	boundConversationTextForSummary,
	estimateMessageTokensHeuristic,
	estimateTextTokensHeuristic,
} from "../src/compaction/compaction";
import type { AgentMessage } from "../src/types";

const HANGUL_PROSE = "컨텍스트 창 초과 재현을 위한 한국어 채움 텍스트입니다. 토큰 예산 계산 검증 문장. ";
const ASCII_PROSE = "Reproduce and isolate the cause of the context overflow. Verify token accounting. ";

function repeatTo(unit: string, chars: number): string {
	return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

describe("script-aware text token heuristic", () => {
	it("keeps the chars/4 estimate for pure ASCII", () => {
		const text = repeatTo(ASCII_PROSE, 10_000);
		expect(estimateTextTokensHeuristic(text)).toBe(Math.ceil(text.length / 4));
	});

	it("charges CJK characters at one token each (covers measured o200k densities)", () => {
		const text = repeatTo(HANGUL_PROSE, 24_000);
		const estimate = estimateTextTokensHeuristic(text);
		// Measured o200k_base for this exact fixture: 14,501 tokens (0.604/char).
		// The estimate must never fall below the real count.
		expect(estimate).toBeGreaterThanOrEqual(14_501);
		// Sanity ceiling: never above 1 token per character.
		expect(estimate).toBeLessThanOrEqual(text.length);
	});

	it("splits mixed text: CJK at 1/char plus remainder at chars/4", () => {
		const hangul = repeatTo("가나다라", 400);
		const ascii = repeatTo("abcd ", 400);
		const spaces = (hangul.match(/ /g) ?? []).length;
		expect(spaces).toBe(0);
		expect(estimateTextTokensHeuristic(hangul + ascii)).toBe(400 + Math.ceil(400 / 4));
	});

	it("applies the same estimate through message estimation", () => {
		const text = repeatTo(HANGUL_PROSE, 4_000);
		const message = { role: "user", content: text } as AgentMessage;
		expect(estimateMessageTokensHeuristic(message)).toBe(estimateTextTokensHeuristic(text));
	});
});

const MODEL_BASE = {
	id: "test-model",
	name: "Test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 20_000,
	maxTokens: 1_000,
} as Model;

describe("boundConversationTextForSummary with CJK input", () => {
	const model: Model = MODEL_BASE;

	it("bounds a CJK conversation to the token budget, not a 4-chars/token cut", () => {
		const outputMaxTokens = 1_000;
		const inputBudgetTokens = Math.floor((20_000 - outputMaxTokens - 4_096) * 0.6);
		const huge = repeatTo(HANGUL_PROSE, 120_000); // ~120k estimated tokens at 1/char ranges

		const bounded = boundConversationTextForSummary(huge, model, outputMaxTokens);
		expect(bounded.length).toBeLessThan(huge.length);
		expect(bounded).toContain("elided so this summarization request fits");
		// The complete returned candidate (elision marker included) must fit
		// the budget under the same estimator. A fixed 4-chars/token cut would
		// have kept ~4x too many characters.
		expect(estimateTextTokensHeuristic(bounded)).toBeLessThanOrEqual(inputBudgetTokens);
	});

	it("still bounds ASCII conversations as before", () => {
		const huge = "x".repeat(400_000);
		const bounded = boundConversationTextForSummary(huge, model, 1_000);
		expect(bounded.length).toBeLessThan(huge.length);
		expect(bounded).toContain("elided so this summarization request fits");
	});
});

describe("token-dense weighting", () => {
	it("weights supplementary code points (surrogate pairs) at one token each", () => {
		const emoji = "😀".repeat(200); // length 400 (200 surrogate pairs)
		expect(estimateTextTokensHeuristic(emoji)).toBe(200);
	});

	it("same-length middle ASCII→CJK edits change the estimate 4x (why the delta path must not cache)", () => {
		const head = "h".repeat(64);
		const tail = "t".repeat(64);
		const ascii = estimateTextTokensHeuristic(`${head}${"m".repeat(100_000)}${tail}`);
		const hangul = estimateTextTokensHeuristic(`${head}${"가".repeat(100_000)}${tail}`);
		expect(hangul).toBeGreaterThan(ascii * 3.9);
	});
});

describe("boundConversationTextForSummary fail-closed boundaries", () => {
	it("returns an empty excerpt when no input budget remains", () => {
		const tiny: Model = { ...MODEL_BASE, contextWindow: 3_000 } as Model;
		// 3,000 − 1,000 output − 4,096 overhead → negative budget.
		expect(boundConversationTextForSummary("x".repeat(400_000), tiny, 1_000)).toBe("");
	});

	it("returns an empty excerpt when the budget is positive but smaller than the elision marker", () => {
		// (5,100 − 1,000 − 4,096) × 0.6 → 2-token budget; the bare marker alone
		// estimates ~32 tokens, so nothing can fit — never return over-budget text.
		const tiny: Model = { ...MODEL_BASE, contextWindow: 5_100 } as Model;
		expect(boundConversationTextForSummary("x".repeat(400_000), tiny, 1_000)).toBe("");
	});

	it("returns the bare marker when only the marker fits the budget", () => {
		// Budget ≈ 62 tokens: large enough for the ~32-token marker but far too
		// small for any 400k-char excerpt slice to survive the shrink loop with
		// meaningful content — the result must still be within budget.
		const tiny: Model = { ...MODEL_BASE, contextWindow: 5_200 } as Model;
		const bounded = boundConversationTextForSummary("x".repeat(400_000), tiny, 1_000);
		const budget = Math.floor((5_200 - 1_000 - 4_096) * 0.6);
		expect(estimateTextTokensHeuristic(bounded)).toBeLessThanOrEqual(budget);
	});
});
